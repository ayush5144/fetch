/**
 * Phase 9 — Smartlead adapter unit tests (normalization, second rail).
 *
 * These tests prove that the Smartlead adapter maps its UPPERCASE webhook
 * vocabulary to our internal event names and resolves lead-match fields from
 * a sparse payload. No network calls are made.
 *
 * getEnv() is primed with DATABASE_URL (required) and SMARTLEAD_API_KEY before
 * any imports so the module-level env cache sees our values.
 *
 * Checklist lines covered (Phase 9):
 *  - Normalize provider event names: Smartlead names map to internal vocabulary
 *  - Match event to local lead by email: sparse payload still yields email + providerEvt
 */

import { vi, describe, it, expect } from 'vitest';

// Prime the env cache BEFORE any module imports.
vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
vi.stubEnv('SMARTLEAD_API_KEY', 'sl-test-key');

// Prevent the Postgres pool from being created at import time.
vi.mock('@fetch/db', () => ({}));

import { SmartleadAdapter } from '../src/index';

// ── SmartleadAdapter.parseEvent ────────────────────────────────────────────

describe('SmartleadAdapter.parseEvent', () => {
  // Smartlead uses UPPERCASE event names in its webhook payloads.
  // This adapter owns that vocabulary; the core never sees it.
  const adapter = new SmartleadAdapter();

  it.each([
    ['EMAIL_OPEN', 'opened'],
    ['EMAIL_OPENED', 'opened'],
    ['EMAIL_REPLY', 'replied'],
    ['EMAIL_REPLIED', 'replied'],
    ['EMAIL_BOUNCE', 'bounced'],
    ['EMAIL_BOUNCED', 'bounced'],
    ['LEAD_UNSUBSCRIBED', 'unsubscribed'],
    ['EMAIL_SENT', 'sent'],
    ['EMAIL_LINK_CLICK', 'clicked'],
    ['EMAIL_CLICKED', 'clicked'],
  ])('maps Smartlead event "%s" to internal type "%s"', (smartleadEvt, expectedType) => {
    const result = adapter.parseEvent({
      event_type: smartleadEvt,
      event_id: 'evt-001',
      to_email: 'lead@example.com',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe(expectedType);
  });

  it('returns null for an unknown event type', () => {
    const result = adapter.parseEvent({ event_type: 'SOME_UNKNOWN', event_id: 'x' });
    expect(result).toBeNull();
  });

  it('returns null for an empty payload', () => {
    const result = adapter.parseEvent({});
    expect(result).toBeNull();
  });

  it('resolves to_email as the lead email in a sparse payload', () => {
    // Smartlead webhooks are intentionally sparse — often just to_email + event type.
    // Proving that a sparse payload still yields email is the Phase 9 checklist line:
    // "a sparse Smartlead payload still resolves to the correct lead".
    const result = adapter.parseEvent({
      event_type: 'EMAIL_OPEN',
      event_id: 'sparse-evt',
      to_email: 'sparse@lead.com',
    });
    expect(result).not.toBeNull();
    expect(result!.email).toBe('sparse@lead.com');
    expect(result!.providerEvt).toBe('sparse-evt');
  });

  it('falls back to lead_email when to_email is absent', () => {
    const result = adapter.parseEvent({
      event_type: 'EMAIL_REPLY',
      event_id: 'evt-fallback',
      lead_email: 'fallback@lead.com',
    });
    expect(result!.email).toBe('fallback@lead.com');
  });

  it('extracts providerLeadId when present', () => {
    const result = adapter.parseEvent({
      event_type: 'EMAIL_BOUNCE',
      event_id: 'evt-bounce',
      to_email: 'bounced@example.com',
      lead_id: 'sl-lead-42',
    });
    expect(result!.providerLeadId).toBe('sl-lead-42');
  });

  it('constructs a synthetic providerEvt key when event_id and id are absent', () => {
    // Without a provider id we synthesize one from type + email + time so the
    // idempotency key is still stable for the same event delivery.
    const result = adapter.parseEvent({
      event_type: 'EMAIL_OPEN',
      to_email: 'test@example.com',
      time_sent: '2024-01-01T00:00:00Z',
    });
    expect(result!.providerEvt).toContain('EMAIL_OPEN');
    expect(result!.providerEvt).toContain('test@example.com');
  });

  it('handles webhook_event_type field as an alias for event_type', () => {
    const result = adapter.parseEvent({
      webhook_event_type: 'EMAIL_OPEN',
      event_id: 'evt-alias',
      to_email: 'alias@example.com',
    });
    expect(result!.type).toBe('opened');
  });
});
