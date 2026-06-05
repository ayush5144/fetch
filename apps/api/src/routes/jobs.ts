import { Hono } from 'hono';
import { db, jobs } from '@fetch/db';
import { enqueue } from '@fetch/core';
import type { JobData } from '@fetch/core';
import { and, desc, eq, sql } from 'drizzle-orm';

/**
 * /jobs — the Job Monitor API. Surfaces the observable projection of queue
 * state (status, attempts, error) and lets an operator retry a failed or
 * dead-lettered job. Retrying re-enqueues the original payload onto the same
 * queue; idempotent handlers make that safe.
 */
export const jobsRoutes = new Hono();

/** List jobs, optionally filtered by status or type, newest first. */
jobsRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const type = c.req.query('type');
  const conditions = [];
  if (status) conditions.push(eq(jobs.status, status));
  if (type) conditions.push(eq(jobs.type, type));

  const rows = await db.query.jobs.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: [desc(jobs.createdAt)],
    limit: 200,
  });
  return c.json({ jobs: rows });
});

/** Aggregate counts per status — drives the monitor's summary tiles. */
jobsRoutes.get('/summary', async (c) => {
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  const summary = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return c.json({ summary });
});

/** Retry a failed/dead job by re-enqueueing its stored payload. */
jobsRoutes.post('/:id/retry', async (c) => {
  const id = c.req.param('id');
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!job) return c.json({ error: 'not found' }, 404);
  if (job.status !== 'failed' && job.status !== 'dead') {
    return c.json({ error: `cannot retry a ${job.status} job` }, 400);
  }

  const newId = await enqueue(job.type as any, job.payload as JobData, {
    leadId: job.leadId ?? undefined,
    campaignId: job.campaignId ?? undefined,
  });
  return c.json({ retried: newId }, 202);
});
