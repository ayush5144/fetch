import { resolveMx } from 'node:dns/promises';
import type { ValidationStatus } from '@fetch/db';
import { getEnv, logger } from '@fetch/core';
import { isDisposable } from './disposable';

/**
 * Email validation — the send gate. Checks run cheapest-first (a free syntax
 * test before an expensive SMTP probe) and short-circuit the moment a result is
 * decided. The returned status is a HARD gate downstream: only `valid` (and,
 * by policy, `risky`) is campaign-eligible.
 */

export interface ValidationResult {
  status: ValidationStatus;
  detail: {
    syntax: boolean;
    mx: boolean;
    smtp?: 'reachable' | 'unreachable' | 'unknown';
    disposable: boolean;
    catchAll?: boolean;
  };
}

// Pragmatic RFC-5322-ish address check — strict enough to reject junk, loose
// enough not to bounce valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export async function validateEmail(email: string | null): Promise<ValidationResult> {
  if (!email) {
    return { status: 'no_email', detail: { syntax: false, mx: false, disposable: false } };
  }
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split('@')[1] ?? '';

  // 1 · Syntax — fail here means no DNS/SMTP work at all.
  if (!EMAIL_RE.test(normalized)) {
    return { status: 'invalid', detail: { syntax: false, mx: false, disposable: false } };
  }

  // 2 · Disposable — a cheap set lookup before any network call.
  if (isDisposable(domain)) {
    return { status: 'disposable', detail: { syntax: true, mx: false, disposable: true } };
  }

  // 3 · MX records — no mail exchanger means the domain can't receive mail.
  let mxHosts: { exchange: string }[] = [];
  try {
    mxHosts = await resolveMx(domain);
  } catch {
    mxHosts = [];
  }
  if (mxHosts.length === 0) {
    return { status: 'invalid', detail: { syntax: true, mx: false, disposable: false } };
  }

  // 4 · SMTP / mailbox reachability via Reacher (optional). Without it we can't
  // prove a mailbox exists, so we land on `risky` rather than over-claiming `valid`.
  const smtp = await checkReacher(normalized);
  const detail = {
    syntax: true,
    mx: true,
    disposable: false,
    smtp: smtp.reachable,
    catchAll: smtp.catchAll,
  };

  if (smtp.reachable === 'unreachable') return { status: 'risky', detail };
  if (smtp.catchAll) return { status: 'risky', detail }; // catch-all ≠ valid, per policy
  if (smtp.reachable === 'reachable') return { status: 'valid', detail };

  // Reacher not configured / unknown: MX is good but mailbox unproven → risky.
  return { status: 'risky', detail };
}

/** Probe mailbox reachability through a Reacher instance, if configured. */
async function checkReacher(
  email: string,
): Promise<{ reachable: 'reachable' | 'unreachable' | 'unknown'; catchAll: boolean }> {
  const base = getEnv().REACHER_URL;
  if (!base) return { reachable: 'unknown', catchAll: false };

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/v0/check_email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_email: email }),
    });
    if (!res.ok) return { reachable: 'unknown', catchAll: false };
    const data = (await res.json()) as any;
    const reachable =
      data.is_reachable === 'safe'
        ? 'reachable'
        : data.is_reachable === 'invalid'
          ? 'unreachable'
          : 'unknown';
    return { reachable, catchAll: Boolean(data.smtp?.is_catch_all) };
  } catch (err) {
    logger.warn('reacher probe failed', { err: String(err) });
    return { reachable: 'unknown', catchAll: false };
  }
}
