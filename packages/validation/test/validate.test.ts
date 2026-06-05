import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 6 — validation. These are pure unit tests: no real DNS, no real SMTP,
 * no database. We stub node:dns/promises so every path through validateEmail
 * is exercised deterministically. REACHER_URL is kept empty throughout so the
 * Reacher branch is never reached (MX-only paths land on `risky`).
 *
 * @fetch/db is mocked because its client.ts eagerly opens a Postgres pool at
 * import time. We only need the exported types (import type), which TypeScript
 * erases, so the mock body can be empty.
 *
 * getEnv() from @fetch/core caches on first call — vi.stubEnv is hoisted
 * alongside vi.mock, so env is patched before any module code runs.
 */

// Provide the minimum env getEnv() requires; keep REACHER_URL empty so the
// Reacher branch never fires (checkReacher returns 'unknown').
vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
vi.stubEnv('REACHER_URL', '');

// Prevent the Postgres pool from being created — only types are needed.
vi.mock('@fetch/db', () => ({}));

// Mock node:dns/promises so no real DNS queries fire.
vi.mock('node:dns/promises', () => ({
  resolveMx: vi.fn(),
}));

// Imports happen AFTER env stubs and mocks are in place.
import { resolveMx } from 'node:dns/promises';
import { isSendable, validateEmail } from '../src/index';

const mockResolveMx = vi.mocked(resolveMx);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Null / missing email ────────────────────────────────────────────────────

describe('validateEmail(null)', () => {
  it('returns no_email when email is null', async () => {
    const result = await validateEmail(null);
    expect(result.status).toBe('no_email');
    // No DNS work should have happened.
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it('returns no_email when email is an empty string', async () => {
    const result = await validateEmail('');
    expect(result.status).toBe('no_email');
    expect(mockResolveMx).not.toHaveBeenCalled();
  });
});

// ── Syntax failures ─────────────────────────────────────────────────────────

describe('syntax check', () => {
  it('returns invalid for a malformed address (no @) with no DNS call', async () => {
    const result = await validateEmail('not-an-email');
    expect(result.status).toBe('invalid');
    expect(result.detail.syntax).toBe(false);
    // Syntax rejects first — no MX or SMTP work should occur.
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it('returns invalid for a missing TLD (no dot in domain)', async () => {
    const result = await validateEmail('user@nodomain');
    expect(result.status).toBe('invalid');
    expect(result.detail.syntax).toBe(false);
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it('returns invalid for a bare @ sign', async () => {
    const result = await validateEmail('@');
    expect(result.status).toBe('invalid');
    expect(mockResolveMx).not.toHaveBeenCalled();
  });
});

// ── Disposable domains ───────────────────────────────────────────────────────

describe('disposable domain detection', () => {
  it('returns disposable for a mailinator.com address', async () => {
    const result = await validateEmail('user@mailinator.com');
    expect(result.status).toBe('disposable');
    expect(result.detail.disposable).toBe(true);
    // Disposable check is a cheap set lookup before any DNS call.
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it('returns disposable for other known throwaway domains', async () => {
    for (const domain of ['guerrillamail.com', 'yopmail.com', '10minutemail.com']) {
      const result = await validateEmail(`user@${domain}`);
      expect(result.status).toBe('disposable');
    }
  });
});

// ── MX-dependent paths ──────────────────────────────────────────────────────

describe('MX record check', () => {
  it('returns invalid when the domain has no MX records', async () => {
    // Simulate a DNS ENOTFOUND / empty response.
    mockResolveMx.mockResolvedValueOnce([]);

    const result = await validateEmail('user@no-mx-domain.example');
    expect(result.status).toBe('invalid');
    expect(result.detail.mx).toBe(false);
  });

  it('returns invalid when resolveMx throws (domain unreachable)', async () => {
    mockResolveMx.mockRejectedValueOnce(new Error('ENOTFOUND'));

    const result = await validateEmail('user@unreachable.example');
    expect(result.status).toBe('invalid');
    expect(result.detail.mx).toBe(false);
  });

  it('returns risky when domain has MX but Reacher is not configured', async () => {
    // Simulate a real mail exchange.
    mockResolveMx.mockResolvedValueOnce([{ exchange: 'mail.real-domain.example', priority: 10 }]);

    // REACHER_URL is stubbed empty, so checkReacher returns 'unknown'.
    // With MX present but mailbox unproven, the result must be `risky`.
    const result = await validateEmail('user@real-domain.example');
    expect(result.status).toBe('risky');
    expect(result.detail.mx).toBe(true);
    expect(result.detail.smtp).toBe('unknown');
  });
});

// ── isSendable ───────────────────────────────────────────────────────────────

describe('isSendable', () => {
  it('valid is always sendable', () => {
    expect(isSendable('valid')).toBe(true);
    expect(isSendable('valid', false)).toBe(true);
    expect(isSendable('valid', true)).toBe(true);
  });

  it('risky is sendable only when allowRisky is true', () => {
    expect(isSendable('risky')).toBe(false);
    expect(isSendable('risky', false)).toBe(false);
    expect(isSendable('risky', true)).toBe(true);
  });

  it('invalid is never sendable', () => {
    expect(isSendable('invalid')).toBe(false);
    expect(isSendable('invalid', true)).toBe(false);
  });

  it('disposable is never sendable', () => {
    expect(isSendable('disposable')).toBe(false);
    expect(isSendable('disposable', true)).toBe(false);
  });

  it('no_email is never sendable', () => {
    expect(isSendable('no_email')).toBe(false);
    expect(isSendable('no_email', true)).toBe(false);
  });

  it('duplicate is never sendable', () => {
    expect(isSendable('duplicate')).toBe(false);
    expect(isSendable('duplicate', true)).toBe(false);
  });
});
