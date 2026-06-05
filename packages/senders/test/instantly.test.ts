/**
 * Phase 8 — Instantly adapter unit tests.
 *
 * All network calls are replaced with a stubbed global fetch; no real HTTP
 * leaves the process. getEnv() caches on first call, so DATABASE_URL and
 * INSTANTLY_API_KEY are stubbed here — at the TOP, before any imports — so
 * the cache is primed with our values.
 *
 * @fetch/db is mocked to prevent its client.ts from eagerly opening a Postgres
 * pool. Only `import type` declarations reference @fetch/db, which TypeScript
 * erases at runtime, so the mock body can be empty.
 *
 * Checklist lines covered (Phase 8):
 *  - Batch sends into chunks of ≤1000 leads (batch helper + 2500-lead test)
 *  - Pass skip-duplicate and verify-on-import flags
 *  - Approved leads map to the correct payload with custom_variables present
 *  - Handle provider errors without losing the batch
 *  - Persist provider_lead_id returned from response
 *  - parseEvent maps Instantly event names to internal vocabulary
 */

import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';

// Prime the env cache BEFORE any module imports so getEnv() sees our values.
vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
vi.stubEnv('INSTANTLY_API_KEY', 'test-key');

// Prevent the Postgres pool from being created at import time.
vi.mock('@fetch/db', () => ({}));

import type { Campaign, Lead } from '@fetch/db';
import { batch, InstantlyAdapter } from '../src/index';

// ── Fixture factories ──────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: `lead-${Math.random().toString(36).slice(2)}`,
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    title: null,
    phone: null,
    linkedinUrl: null,
    accountId: null,
    sourceId: null,
    enrichmentStatus: 'pending',
    enrichmentConf: {},
    validationStatus: 'valid',
    validationDetail: {},
    subject: 'Hello',
    body: 'World',
    promptVersion: null,
    approvalStatus: 'approved',
    campaignId: null,
    provider: null,
    providerLeadId: null,
    sendStatus: 'none',
    sentAt: null,
    openedAt: null,
    clickedAt: null,
    repliedAt: null,
    bouncedAt: null,
    unsubscribedAt: null,
    data: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Lead;
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    providerRef: 'instantly-campaign-id',
    provider: 'instantly',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Campaign;
}

/** Build N distinct leads — used for the 2500-lead batching test. */
function makeLeads(n: number): Lead[] {
  return Array.from({ length: n }, (_, i) =>
    makeLead({ id: `lead-${i}`, email: `user${i}@example.com` }),
  );
}

// ── batch() helper ─────────────────────────────────────────────────────────

describe('batch() helper', () => {
  // The core batching utility used by adapters to honor provider caps.
  it('splits a flat list into chunks of the given size', () => {
    const items = Array.from({ length: 2500 }, (_, i) => i);
    const chunks = batch(items, 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(1000);
    expect(chunks[2]).toHaveLength(500);
  });

  it('returns a single chunk when the list is smaller than the batch size', () => {
    const items = [1, 2, 3];
    const chunks = batch(items, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([1, 2, 3]);
  });

  it('returns an empty array for an empty input', () => {
    expect(batch([], 10)).toEqual([]);
  });

  it('produces exactly-sized chunks when the list divides evenly', () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const chunks = batch(items, 2);
    expect(chunks).toHaveLength(3);
    chunks.forEach((c) => expect(c).toHaveLength(2));
  });
});

// ── InstantlyAdapter.push — happy path ────────────────────────────────────

describe('InstantlyAdapter.push — available when key is set', () => {
  let adapter: InstantlyAdapter;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new InstantlyAdapter();
    // Replace global fetch so no real HTTP escapes.
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ leads: [{ email: 'test@example.com', id: 'instantly-lead-id' }] }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports available:true when INSTANTLY_API_KEY is set', () => {
    expect(adapter.available).toBe(true);
  });

  it('sends the correct flags: skip_if_in_workspace and verify_leads_on_import', async () => {
    const leads = [makeLead()];
    await adapter.push(leads, makeCampaign());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // These are the two skip-duplicate / verify-on-import flags required by Phase 8.
    expect(body.skip_if_in_workspace).toBe(true);
    expect(body.verify_leads_on_import).toBe(true);
  });

  it('includes custom_variables with fetch_lead_id on every lead payload', async () => {
    const lead = makeLead({ id: 'my-lead-id' });
    await adapter.push([lead], makeCampaign());

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const sentLead = body.leads[0];
    expect(sentLead.custom_variables).toBeDefined();
    expect(sentLead.custom_variables.fetch_lead_id).toBe('my-lead-id');
  });

  it('returns ok:true with the provider_lead_id from the response', async () => {
    const lead = makeLead({ email: 'test@example.com' });
    const results = await adapter.push([lead], makeCampaign());

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    // The adapter matches provider_lead_id back by email from the response.
    expect(results[0].providerLeadId).toBe('instantly-lead-id');
  });

  it('issues exactly 3 fetch calls for 2500 leads (≤1000 batching)', async () => {
    // Mock the response for all batches.
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ leads: [] }) });

    const leads = makeLeads(2500);
    const results = await adapter.push(leads, makeCampaign());

    // 2500 leads / 1000-per-batch = 3 requests.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Every lead still has a result entry — none dropped.
    expect(results).toHaveLength(2500);
  });

  it('posts to the correct Instantly API endpoint with a Bearer token', async () => {
    await adapter.push([makeLead()], makeCampaign());

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.instantly.ai/api/v2/leads');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
  });
});

// ── InstantlyAdapter.push — error handling ─────────────────────────────────

describe('InstantlyAdapter.push — error handling', () => {
  let adapter: InstantlyAdapter;

  beforeEach(() => {
    adapter = new InstantlyAdapter();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks every lead in a failed chunk as ok:false with an error message', async () => {
    // Simulate a 400 error response — the whole chunk fails, but no error is thrown.
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as Response);

    const leads = [
      makeLead({ id: 'lead-a', email: 'a@example.com' }),
      makeLead({ id: 'lead-b', email: 'b@example.com' }),
    ];
    const results = await adapter.push(leads, makeCampaign());

    // Both leads in the failed chunk must be present and marked failed.
    expect(results).toHaveLength(2);
    results.forEach((r) => {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/instantly 400/);
    });
  });

  it('continues other batches when one batch fails (no batch is lost)', async () => {
    // First batch (1000 leads): fails. Second batch: succeeds.
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ leads: [] }),
      } as unknown as Response);

    const leads = makeLeads(1100); // two batches: 1000 + 100
    const results = await adapter.push(leads, makeCampaign());

    // All 1100 results must be present; none silently dropped.
    expect(results).toHaveLength(1100);
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);
    expect(failed).toHaveLength(1000); // first batch failed
    expect(succeeded).toHaveLength(100); // second batch succeeded
  });

  it('handles a thrown network error without losing the batch', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network timeout'));

    const leads = [makeLead({ id: 'lead-a' }), makeLead({ id: 'lead-b' })];
    const results = await adapter.push(leads, makeCampaign());

    expect(results).toHaveLength(2);
    results.forEach((r) => {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/instantly request failed/);
    });
  });
});

// ── InstantlyAdapter — key not set ─────────────────────────────────────────

describe('InstantlyAdapter — key not set', () => {
  // We need a fresh module context where INSTANTLY_API_KEY is absent so the
  // adapter constructor sees no key when it calls getEnv().
  it('returns all-failed without calling fetch when INSTANTLY_API_KEY is absent', async () => {
    // Reset modules so getEnv()'s module-level cache is cleared, then import
    // with the key absent so the cache is primed with no key.
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
    // INSTANTLY_API_KEY intentionally not set.

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Dynamic import gets a fresh copy of the module with the reset env cache.
    const { InstantlyAdapter: FreshAdapter } = await import('../src/index');
    const adapter = new FreshAdapter();

    expect(adapter.available).toBe(false);

    const leads = [makeLead({ id: 'x' })];
    const results = await adapter.push(leads, makeCampaign());

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/instantly not configured/);
    // No HTTP call should have been made.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── InstantlyAdapter.parseEvent ────────────────────────────────────────────

describe('InstantlyAdapter.parseEvent', () => {
  // The adapter owns Instantly's webhook vocabulary. These tests prove the
  // mapping so the core never needs to know provider-specific event names.
  const adapter = new InstantlyAdapter();

  it.each([
    ['email_opened', 'opened'],
    ['reply_received', 'replied'],
    ['email_bounced', 'bounced'],
    ['lead_unsubscribed', 'unsubscribed'],
    ['email_sent', 'sent'],
    ['email_link_clicked', 'clicked'],
  ])('maps Instantly event "%s" to internal type "%s"', (instantlyEvt, expectedType) => {
    const result = adapter.parseEvent({
      event_type: instantlyEvt,
      id: 'evt-123',
      lead_email: 'user@example.com',
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe(expectedType);
  });

  it('returns null for an unknown event type', () => {
    const result = adapter.parseEvent({ event_type: 'some_unknown_event', id: 'x' });
    expect(result).toBeNull();
  });

  it('extracts email, providerLeadId, and providerEvt from the payload', () => {
    const result = adapter.parseEvent({
      event_type: 'email_opened',
      id: 'evt-abc',
      lead_email: 'target@example.com',
      lead_id: 'provider-lead-99',
    });
    expect(result!.email).toBe('target@example.com');
    expect(result!.providerLeadId).toBe('provider-lead-99');
    expect(result!.providerEvt).toBe('evt-abc');
  });

  it('falls back to the event field when event_type is absent', () => {
    const result = adapter.parseEvent({ event: 'email_open', id: 'evt-fallback' });
    expect(result!.type).toBe('opened');
  });
});
