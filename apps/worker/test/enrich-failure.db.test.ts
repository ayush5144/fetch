import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, auditLog, columns, db, jobs, leads } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';
import { app } from '../../../apps/api/src/app';

/**
 * Phase J · Round 2 — failures are first-class and per-cell. We force the Dogi
 * resolver (runDogi) to fill or miss deterministically (no network), then assert:
 *   - a miss records enrichmentConf[key] = { status:'failed', error, at } with NO
 *     value in data (cell stays empty / re-runnable) AND an enrich_failed audit row;
 *   - a fill records enrichmentConf[key].status === 'filled';
 *   - the per-LEAD enrichmentStatus is DERIVED from all dogi cells, not last-writer-wins;
 *   - POST /leads/:id/run enqueues the lead's dogi columns.
 */

// runDogi is the cell primitive; stub it so we control fill vs miss per column.
const { runDogi } = vi.hoisted(() => ({ runDogi: vi.fn() }));
vi.mock('@fetch/agent', async (orig) => ({ ...(await orig<any>()), runDogi }));

const { enrichHandler } = await import('../src/handlers/enrich');

const T = DEFAULT_TABLE_ID;

async function makeDogiColumn(key: string) {
  await db
    .insert(columns)
    .values({ tableId: T, key, label: key, type: 'dogi', config: { kind: 'dogi', instruction: key } })
    .returning();
}

async function makeLead(email: string) {
  const [lead] = await db.insert(leads).values({ tableId: T, email }).returning();
  return lead!;
}

beforeAll(startQueues);
afterAll(stopQueues);
beforeEach(async () => {
  await truncateAll();
  runDogi.mockReset();
});

describe('per-cell failure state', () => {
  it('a Dogi miss writes status:failed + an enrich_failed audit row, no value in data', async () => {
    await makeDogiColumn('ceo_linkedin');
    const lead = await makeLead('a@x.com');

    runDogi.mockResolvedValue(null); // miss
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_linkedin' });

    const updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    const conf = (updated!.enrichmentConf as any).ceo_linkedin;
    expect(conf.status).toBe('failed');
    expect(typeof conf.error).toBe('string');
    expect(typeof conf.at).toBe('string');
    // No value written → cell still empty → re-runnable.
    expect((updated!.data as any).ceo_linkedin).toBeUndefined();

    const audits = await db.query.auditLog.findMany({ where: eq(auditLog.action, 'enrich_failed') });
    expect(audits).toHaveLength(1);
    expect((audits[0]!.diff as any).field).toBe('ceo_linkedin');
  });

  it('a thrown error records status:failed with the message + audit, then re-throws', async () => {
    await makeDogiColumn('ceo_name');
    const lead = await makeLead('b@x.com');

    runDogi.mockRejectedValue(new Error('provider 500'));
    await expect(enrichHandler({ leadId: lead.id, columnKey: 'ceo_name' })).rejects.toThrow('provider 500');

    const updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    const conf = (updated!.enrichmentConf as any).ceo_name;
    expect(conf.status).toBe('failed');
    expect(conf.error).toBe('provider 500');

    const audits = await db.query.auditLog.findMany({ where: eq(auditLog.action, 'enrich_failed') });
    expect(audits).toHaveLength(1);
  });

  it('a fill writes status:filled alongside confidence/source/provider', async () => {
    await makeDogiColumn('ceo_name');
    const lead = await makeLead('c@x.com');

    runDogi.mockResolvedValue({ value: 'Jane Doe', confidence: 0.9, source: 'https://x', provider: 'llm' });
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_name' });

    const updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect((updated!.data as any).ceo_name).toBe('Jane Doe');
    const conf = (updated!.enrichmentConf as any).ceo_name;
    expect(conf.status).toBe('filled');
    expect(conf.confidence).toBe(0.9);
    expect(conf.provider).toBe('llm');
  });
});

describe('per-lead status is derived from all dogi cells (not last-writer-wins)', () => {
  it('a partial fill where another column missed reads as failed, not done', async () => {
    await makeDogiColumn('ceo_name');
    await makeDogiColumn('ceo_linkedin');
    const lead = await makeLead('d@x.com');

    // CEO fills.
    runDogi.mockResolvedValue({ value: 'Jane', confidence: 0.9, source: null, provider: 'llm' });
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_name' });

    let updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    // Only one of two attempted, the other never run → still running, not "done".
    expect(updated!.enrichmentStatus).toBe('running');

    // LinkedIn misses (last writer) — old code would set "failed" off this cell;
    // new code derives: one failed, none pending → failed (correctly surfaced).
    runDogi.mockResolvedValue(null);
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_linkedin' });

    updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(updated!.enrichmentStatus).toBe('failed');
  });

  it('all dogi cells filled → done', async () => {
    await makeDogiColumn('ceo_name');
    await makeDogiColumn('ceo_linkedin');
    const lead = await makeLead('e@x.com');

    runDogi.mockResolvedValue({ value: 'v', confidence: 0.9, source: null, provider: 'llm' });
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_name' });
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_linkedin' });

    const updated = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(updated!.enrichmentStatus).toBe('done');
  });
});

describe('POST /leads/:id/run', () => {
  it('enqueues all empty dogi columns for the lead', async () => {
    await makeDogiColumn('ceo_name');
    await makeDogiColumn('ceo_linkedin');
    await db
      .insert(columns)
      .values({ tableId: T, key: 'note', label: 'Note', type: 'manual', config: {} });
    const lead = await makeLead('f@x.com');

    const res = await app.request(`/leads/${lead.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).enqueued).toBe(2); // two dogi columns, manual ignored

    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    const keys = enrichJobs.map((j) => (j.payload as any).columnKey).sort();
    expect(keys).toEqual(['ceo_linkedin', 'ceo_name']);
  });

  it('run-only-if-empty by default; force re-runs filled cells', async () => {
    await makeDogiColumn('ceo_name');
    const lead = await makeLead('g@x.com');

    // Fill the cell first.
    runDogi.mockResolvedValue({ value: 'v', confidence: 0.9, source: null, provider: 'llm' });
    await enrichHandler({ leadId: lead.id, columnKey: 'ceo_name' });

    // Default: nothing enqueued (cell already filled).
    let res = await app.request(`/leads/${lead.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect((await res.json()).enqueued).toBe(0);

    // Force: clears the value and re-enqueues.
    res = await app.request(`/leads/${lead.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect((await res.json()).enqueued).toBe(1);

    const cleared = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect((cleared!.data as any).ceo_name).toBeUndefined(); // value cleared for re-run
  });
});
