import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, jobs, leads } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';
import { writeCell } from '@fetch/columns';

/**
 * Phase D — dependency-ordered execution. After a plan's step-1 cell is filled
 * for a lead, the enrich handler must enqueue step 2 (whose `config.dependsOn`
 * includes step 1's key) — and only once step 1 is done, per lead, idempotently.
 *
 * We mock runCell so step 1's "fill" is deterministic (no LLM/provider network);
 * the chaining itself is what we assert.
 */
const { runCell } = vi.hoisted(() => ({ runCell: vi.fn() }));
vi.mock('@fetch/columns', async (orig) => ({ ...(await orig<any>()), runCell }));

const { enrichHandler } = await import('../src/handlers/enrich');

const T = DEFAULT_TABLE_ID;

async function makeDogiColumn(key: string, dependsOn: string[]) {
  await db
    .insert(columns)
    .values({
      tableId: T,
      key,
      label: key,
      type: 'dogi',
      config: { kind: 'dogi', instruction: key, reads: dependsOn, output: { mode: 'create', key }, dependsOn },
    })
    .returning();
}

beforeAll(startQueues);
afterAll(stopQueues);
beforeEach(async () => {
  await truncateAll();
  runCell.mockReset();
});

describe('enrich handler — goal-mode chaining', () => {
  it('enqueues step 2 only after step 1 fills, per lead', async () => {
    await makeDogiColumn('ceo_email', []);
    await makeDogiColumn('custom_email', ['ceo_email']);
    const [lead] = await db.insert(leads).values({ tableId: T, email: 'a@x.com' }).returning();

    // Simulate step 1 filling its cell, then run the handler for step 1.
    runCell.mockImplementation(async (leadId: string, columnKey: string) => {
      await writeCell(leadId, columnKey, { value: 'ceo@acme.com', confidence: 0.9, source: null });
      return true;
    });

    await enrichHandler({ leadId: lead!.id, columnKey: 'ceo_email' });

    // The dependent step (custom_email) is now enqueued for this lead.
    const chained = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    const keys = chained.map((j) => (j.payload as any).columnKey);
    expect(keys).toContain('custom_email');
    expect(chained.find((j) => (j.payload as any).columnKey === 'custom_email')!.leadId).toBe(lead!.id);
  });

  it('does not enqueue the dependent before its dependency is filled', async () => {
    await makeDogiColumn('ceo_email', []);
    await makeDogiColumn('custom_email', ['ceo_email']);
    const [lead] = await db.insert(leads).values({ tableId: T, email: 'b@x.com' }).returning();

    // runCell reports a miss → cell stays empty → no chaining.
    runCell.mockResolvedValue(false);
    await enrichHandler({ leadId: lead!.id, columnKey: 'ceo_email' });

    const chained = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(chained.map((j) => (j.payload as any).columnKey)).not.toContain('custom_email');
  });

  it('is idempotent: a dependent whose cell is already filled is not re-enqueued', async () => {
    await makeDogiColumn('ceo_email', []);
    await makeDogiColumn('custom_email', ['ceo_email']);
    const [lead] = await db
      .insert(leads)
      .values({ tableId: T, email: 'c@x.com', data: { custom_email: 'already written' } })
      .returning();

    runCell.mockImplementation(async (leadId: string, columnKey: string) => {
      await writeCell(leadId, columnKey, { value: 'ceo@acme.com', confidence: 0.9, source: null });
      return true;
    });
    await enrichHandler({ leadId: lead!.id, columnKey: 'ceo_email' });

    const chained = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(chained.map((j) => (j.payload as any).columnKey)).not.toContain('custom_email');
  });
});
