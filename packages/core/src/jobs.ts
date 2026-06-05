import { db, jobs as jobsTable } from '@fetch/db';
import type { JobType } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';
import { getBoss, QUEUES } from './queue';
import type { JobData } from './types';
import { logger } from './logger';

/**
 * Enqueue one job. This does two things atomically-in-spirit:
 *   1. writes a row into the `jobs` table — the observable projection the Job
 *      Monitor renders (status, attempts, error);
 *   2. sends the payload to the pg-boss queue, where a worker will claim it.
 *
 * The `jobs.id` is threaded through as the pg-boss singletonKey so the worker
 * can update the same row as it transitions queued → active → completed.
 */
export async function enqueue<T extends JobType>(
  type: T,
  data: JobData<T>,
  opts: { leadId?: string; campaignId?: string } = {},
): Promise<string> {
  const leadId = opts.leadId ?? (data as { leadId?: string }).leadId ?? null;
  const campaignId = opts.campaignId ?? (data as { campaignId?: string }).campaignId ?? null;

  // 1. Record the job for the UI.
  const [row] = await db
    .insert(jobsTable)
    .values({ type, leadId, campaignId, status: 'queued', payload: data as object })
    .returning({ id: jobsTable.id });

  const jobRowId = row!.id;

  // 2. Hand it to the queue, carrying our row id so the worker can correlate.
  const boss = getBoss();
  await boss.send(QUEUES[type], { ...data, __jobRowId: jobRowId });

  logger.child({ job_id: jobRowId, lead_id: leadId }).info('job enqueued', { type });
  return jobRowId;
}

/** Transition a job row's status; used by the worker around handler execution. */
export async function markJob(
  jobRowId: string,
  status: 'active' | 'completed' | 'failed' | 'dead',
  patch: { error?: string; bumpAttempt?: boolean } = {},
): Promise<void> {
  await db
    .update(jobsTable)
    .set({
      status,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      // Increment the attempt counter atomically when a worker claims the job.
      ...(patch.bumpAttempt ? { attempts: sql`${jobsTable.attempts} + 1` } : {}),
      ...(status === 'completed' || status === 'dead' ? { completedAt: new Date() } : {}),
    })
    .where(eq(jobsTable.id, jobRowId));
}
