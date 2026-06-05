import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, db, jobs, sources } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { enqueue, markJob } from '../src/jobs';
import { QUEUES, startQueues, stopQueues } from '../src/queue';
import { ingestLead } from '../src/dedupe';

/**
 * Phase 3 — job system. Proves the observable `jobs` mirror and the queue
 * registration against a real Postgres + pg-boss (queue lives in the same DB,
 * which is the whole no-Redis point). The full retry→dead-letter timing is left
 * to manual/integration runs (it needs real backoff delays); here we prove the
 * state machine the monitor renders.
 */
describe('job system', () => {
  beforeAll(async () => {
    await startQueues();
  });
  afterAll(async () => {
    await stopQueues();
  });
  beforeEach(truncateAll);

  it('registers all five work queues (and their dead-letter siblings)', async () => {
    const rows = await db.execute<{ name: string }>(sql`SELECT name FROM pgboss.queue`);
    const names = new Set((rows.rows ?? rows).map((r: any) => r.name));
    for (const q of Object.values(QUEUES)) {
      expect(names.has(q), `queue ${q} registered`).toBe(true);
      expect(names.has(`${q}.dead`), `dead-letter ${q}.dead registered`).toBe(true);
    }
  });

  it('mirrors an enqueued job into the jobs table as queued, with its payload', async () => {
    const leadId = await makeLead();
    const jobRowId = await enqueue('validate', { leadId }, { leadId });

    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobRowId) });
    expect(row).toBeTruthy();
    expect(row!.type).toBe('validate');
    expect(row!.status).toBe('queued');
    expect(row!.leadId).toBe(leadId);
    expect(row!.payload).toMatchObject({ leadId });
  });

  it('transitions queued → active → completed and bumps the attempt counter', async () => {
    const leadId = await makeLead();
    const jobRowId = await enqueue('validate', { leadId }, { leadId });

    await markJob(jobRowId, 'active', { bumpAttempt: true });
    let row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobRowId) });
    expect(row!.status).toBe('active');
    expect(row!.attempts).toBe(1);

    await markJob(jobRowId, 'completed');
    row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobRowId) });
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).toBeTruthy();
  });

  it('records a failure with its error, and marks dead on exhaustion', async () => {
    const leadId = await makeLead();
    const jobRowId = await enqueue('validate', { leadId }, { leadId });

    await markJob(jobRowId, 'failed', { error: 'boom' });
    let row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobRowId) });
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('boom');

    await markJob(jobRowId, 'dead', { error: 'retries exhausted' });
    row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobRowId) });
    expect(row!.status).toBe('dead');
    expect(row!.completedAt).toBeTruthy();
  });
});

/** Create a real lead so the jobs.lead_id foreign key is satisfiable. */
async function makeLead(): Promise<string> {
  const [src] = await db.insert(sources).values({ type: 'csv', raw: {} }).returning();
  const canonical = new CsvNormalizer().normalize('email\nava@acme.com')[0]!;
  const { lead } = await ingestLead(canonical, { sourceId: src!.id, tableId: DEFAULT_TABLE_ID });
  return lead.id;
}
