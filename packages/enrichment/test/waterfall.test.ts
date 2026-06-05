/**
 * We must mock @fetch/db before any test code runs because db/src/client.ts
 * initialises a pg Pool at module load time, which requires DATABASE_URL.
 * These unit tests are pure in-memory — they need the Lead *type* only (erased
 * at runtime), not a real database connection.
 */
import { vi } from 'vitest';

vi.mock('@fetch/db', () => ({
  // client exports — never called in unit tests
  pool: {},
  db: {},
  schema: {},
  pingDb: vi.fn(),
  closeDb: vi.fn(),
  // schema re-exports needed transitively — just stubs
  leads: {},
  dataContains: vi.fn(),
}));

import { describe, expect, it } from 'vitest';
import type { Lead } from '@fetch/db';
import type { Provider, ProviderResult } from '../src/provider';
import { Waterfall } from '../src/waterfall';

/**
 * Phase 5 — enrichment waterfall.
 *
 * All tests use fake in-memory providers (no Apollo/Hunter, no network).
 * The point is to prove the four behavioural invariants from the checklist:
 *   1. stop-on-first-hit (call count)
 *   2. cheapest-first ordering
 *   3. per-(field, domain) cache — one provider call per domain, not per lead
 *   4. a throwing provider is a miss, not a fatal
 *   5. all-miss returns null
 */

// ── Fixture helpers ────────────────────────────────────────────────────────

/** Minimal Lead fixture for waterfall use — only email matters for caching. */
function makeLead(email: string, id = 'lead-1'): Lead {
  return {
    id,
    email,
    firstName: null,
    lastName: null,
    title: null,
    phone: null,
    linkedinUrl: null,
    accountId: null,
    sourceId: null,
    enrichmentStatus: 'pending',
    enrichmentConf: {},
    validationStatus: 'unchecked',
    validationDetail: {},
    subject: null,
    body: null,
    promptVersion: null,
    approvalStatus: 'draft',
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
  } as unknown as Lead;
}

/** A fake provider whose lookup returns a static value and tracks call count. */
function makeHitProvider(opts: {
  name: string;
  cost: number;
  field: string;
  value: string;
  calls?: { count: number };
}): Provider & { calls: { count: number } } {
  const calls = opts.calls ?? { count: 0 };
  return {
    name: opts.name,
    cost: opts.cost,
    supports: (f) => f === opts.field,
    lookup: async (_f, _lead): Promise<ProviderResult> => {
      calls.count++;
      return { value: opts.value, confidence: 0.9, source: `https://${opts.name}.example` };
    },
    calls,
  };
}

/** A fake provider that always returns null (miss). */
function makeMissProvider(name: string, cost: number, field: string): Provider {
  return {
    name,
    cost,
    supports: (f) => f === field,
    lookup: async () => null,
  };
}

/** A fake provider whose lookup throws. */
function makeThrowingProvider(name: string, cost: number, field: string): Provider {
  return {
    name,
    cost,
    supports: (f) => f === field,
    lookup: async () => {
      throw new Error('provider exploded');
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Waterfall — stop-on-first-hit', () => {
  // Checklist: "when provider A returns a value, providers B and C are not called"
  it('does not call a later provider when an earlier one returns a value', async () => {
    const callsA = { count: 0 };
    const callsB = { count: 0 };

    const providerA = makeHitProvider({ name: 'ProviderA', cost: 1, field: 'company_name', value: 'Acme', calls: callsA });
    const providerB = makeHitProvider({ name: 'ProviderB', cost: 2, field: 'company_name', value: 'Other', calls: callsB });

    const waterfall = new Waterfall([providerA, providerB]);
    const result = await waterfall.run('company_name', makeLead('alice@acme.com'));

    expect(result?.value).toBe('Acme');
    expect(callsA.count).toBe(1); // A was called exactly once
    expect(callsB.count).toBe(0); // B was never reached after A hit
  });
});

describe('Waterfall — cheapest-first ordering', () => {
  // Checklist: lower-cost provider is tried before a higher-cost one
  it('calls the lower-cost provider first even when registered in reverse order', async () => {
    const callOrder: string[] = [];

    const expensive: Provider = {
      name: 'Expensive',
      cost: 10,
      supports: () => true,
      lookup: async (_f, _lead) => {
        callOrder.push('Expensive');
        return null; // miss so both providers are called and we can check order
      },
    };

    const cheap: Provider = {
      name: 'Cheap',
      cost: 1,
      supports: () => true,
      lookup: async (_f, _lead) => {
        callOrder.push('Cheap');
        return null;
      },
    };

    // Intentionally register expensive first; the waterfall must reorder by cost.
    const waterfall = new Waterfall([expensive, cheap]);
    await waterfall.run('title', makeLead('bob@example.com'));

    expect(callOrder[0]).toBe('Cheap');
    expect(callOrder[1]).toBe('Expensive');
  });
});

describe('Waterfall — per-(field, domain) cache', () => {
  // Checklist: "a second lead at the same domain reuses the cached value with no new paid call"
  it('only calls the provider once for two leads sharing the same email domain', async () => {
    const calls = { count: 0 };
    const provider = makeHitProvider({ name: 'Cached', cost: 1, field: 'industry', value: 'SaaS', calls });

    const waterfall = new Waterfall([provider]);

    const lead1 = makeLead('alice@acme.com', 'lead-1');
    const lead2 = makeLead('bob@acme.com', 'lead-2');

    const r1 = await waterfall.run('industry', lead1);
    const r2 = await waterfall.run('industry', lead2);

    expect(r1?.value).toBe('SaaS');
    expect(r2?.value).toBe('SaaS');
    // Same domain → cache hit on second call; provider invoked only once.
    expect(calls.count).toBe(1);
  });

  it('does NOT share the cache across different domains', async () => {
    const calls = { count: 0 };
    const provider = makeHitProvider({ name: 'CrossDomain', cost: 1, field: 'industry', value: 'SaaS', calls });

    const waterfall = new Waterfall([provider]);

    await waterfall.run('industry', makeLead('alice@acme.com', 'lead-1'));
    await waterfall.run('industry', makeLead('bob@globex.io', 'lead-2'));

    expect(calls.count).toBe(2);
  });

  it('caches null (all-miss) so the provider is not re-queried for a miss domain', async () => {
    const calls = { count: 0 };
    const miss: Provider = {
      name: 'Misser',
      cost: 1,
      supports: () => true,
      lookup: async () => {
        calls.count++;
        return null;
      },
    };

    const waterfall = new Waterfall([miss]);
    await waterfall.run('company_size', makeLead('x@same.io', 'lead-1'));
    await waterfall.run('company_size', makeLead('y@same.io', 'lead-2'));

    expect(calls.count).toBe(1); // second call is served from null-cache
  });
});

describe('Waterfall — provider throws treated as miss', () => {
  // Checklist: "a tool failure is handled, not fatal"
  it('continues to the next provider when one throws instead of crashing', async () => {
    const thrower = makeThrowingProvider('Thrower', 1, 'phone');
    const fallback = makeHitProvider({ name: 'Fallback', cost: 2, field: 'phone', value: '+1-555-0100' });

    const waterfall = new Waterfall([thrower, fallback]);
    const result = await waterfall.run('phone', makeLead('eve@corp.io'));

    expect(result?.value).toBe('+1-555-0100');
    expect(result?.provider).toBe('Fallback');
  });

  it('returns null when the only provider throws', async () => {
    const waterfall = new Waterfall([makeThrowingProvider('OnlyOne', 1, 'phone')]);
    const result = await waterfall.run('phone', makeLead('eve@corp.io'));
    expect(result).toBeNull();
  });
});

describe('Waterfall — all-miss returns null', () => {
  it('returns null when every provider returns null', async () => {
    const miss1 = makeMissProvider('Miss1', 1, 'company_size');
    const miss2 = makeMissProvider('Miss2', 2, 'company_size');

    const waterfall = new Waterfall([miss1, miss2]);
    const result = await waterfall.run('company_size', makeLead('tom@nobody.dev'));

    expect(result).toBeNull();
  });

  it('returns null for a field that no provider supports', async () => {
    const provider = makeHitProvider({ name: 'TitleOnly', cost: 1, field: 'title', value: 'CEO' });

    const waterfall = new Waterfall([provider]);
    const result = await waterfall.run('phone', makeLead('ceo@corp.io'));

    expect(result).toBeNull();
  });
});

describe('Waterfall — provider registration', () => {
  // Checklist: "a mock provider can be registered and called by the waterfall"
  it('exposes activeProviders listing injected providers in cost order', () => {
    const p1 = makeMissProvider('Beta', 2, 'email');
    const p2 = makeMissProvider('Alpha', 1, 'email');
    const waterfall = new Waterfall([p1, p2]);
    // sorted cheapest-first, so Alpha (cost=1) comes before Beta (cost=2)
    expect(waterfall.activeProviders).toEqual(['Alpha', 'Beta']);
  });
});
