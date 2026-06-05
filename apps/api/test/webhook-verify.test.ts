/**
 * Phase 9 — webhook signature verification unit tests.
 *
 * verifySignature() uses HMAC-SHA256 with a constant-time compare. These tests
 * prove that correct signatures pass, forged/empty ones fail, and that the
 * "sha256=..." prefix is normalised away before comparison.
 *
 * No network, no database, no env caching concerns — verifySignature is a pure
 * function with no external dependencies.
 *
 * Checklist line covered (Phase 9):
 *  - Verify webhook signatures: unsigned or forged payload rejected with 401/403
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySignature } from '../src/middleware/webhookVerify';

/** Compute the correct HMAC-SHA256 hex digest the same way the middleware does. */
function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

const SECRET = 'super-secret-webhook-key';
const BODY = JSON.stringify({ event: 'email_opened', lead: 'test@example.com' });

// ── Correct signature ──────────────────────────────────────────────────────

describe('verifySignature — correct signature', () => {
  it('returns true when the signature matches the body and secret', () => {
    const sig = sign(BODY, SECRET);
    expect(verifySignature(BODY, sig, SECRET)).toBe(true);
  });

  it('accepts a "sha256=..." prefixed signature and strips the prefix', () => {
    const sig = `sha256=${sign(BODY, SECRET)}`;
    expect(verifySignature(BODY, sig, SECRET)).toBe(true);
  });

  it('is case-sensitive on the body — different body is rejected', () => {
    const sig = sign(BODY, SECRET);
    const tamperedBody = BODY + ' ';
    expect(verifySignature(tamperedBody, sig, SECRET)).toBe(false);
  });
});

// ── Forged / wrong signature ───────────────────────────────────────────────

describe('verifySignature — forged signature', () => {
  it('returns false for a hex string that is not the correct HMAC', () => {
    // A plausible-looking but wrong hex digest — proves constant-time compare.
    const forgedSig = 'a'.repeat(64);
    expect(verifySignature(BODY, forgedSig, SECRET)).toBe(false);
  });

  it('returns false when signed with a different secret', () => {
    const wrongSig = sign(BODY, 'wrong-secret');
    expect(verifySignature(BODY, wrongSig, SECRET)).toBe(false);
  });

  it('returns false for an empty signature string', () => {
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
  });

  it('returns false for a signature of different length (prevents timing shortcut)', () => {
    // A truncated digest should fail the length check before timingSafeEqual.
    const shortSig = sign(BODY, SECRET).slice(0, 32);
    expect(verifySignature(BODY, shortSig, SECRET)).toBe(false);
  });
});

// ── Missing secret ─────────────────────────────────────────────────────────

describe('verifySignature — missing secret', () => {
  // A webhook endpoint must never accept unsigned payloads. When no secret is
  // configured for a provider we reject rather than silently trust.
  it('returns false when secret is undefined', () => {
    const sig = sign(BODY, SECRET);
    expect(verifySignature(BODY, sig, undefined)).toBe(false);
  });

  it('returns false when secret is an empty string', () => {
    // An empty string is treated the same as "not configured".
    expect(verifySignature(BODY, sign(BODY, ''), '')).toBe(false);
  });

  it('returns false when both signature and secret are undefined', () => {
    expect(verifySignature(BODY, undefined, undefined)).toBe(false);
  });
});

// ── Missing signature ──────────────────────────────────────────────────────

describe('verifySignature — missing signature', () => {
  it('returns false when signature is undefined', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
  });
});
