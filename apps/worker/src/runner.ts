import { logger, markJob } from '@fetch/core';
import type PgBoss from 'pg-boss';

/**
 * The shared handler wrapper. Every queue handler runs through here so the
 * cross-cutting concerns live in ONE place:
 *   - correlate the pg-boss job to its `jobs` table row (via __jobRowId);
 *   - mark active → completed | failed and record the error for the monitor;
 *   - keep structured logs keyed by job_id + lead_id.
 *
 * pg-boss owns the retry/backoff/dead-letter mechanics; throwing from a handler
 * tells pg-boss to retry (and eventually dead-letter). We just mirror the
 * outcome into the observable `jobs` row.
 */
export type Handler<T> = (data: T) => Promise<void>;

/** What every queued payload carries on top of its typed data. */
interface Envelope {
  __jobRowId?: string;
}

export function wrap<T>(type: string, handler: Handler<T>) {
  return async (jobs: PgBoss.Job<T & Envelope>[]): Promise<void> => {
    for (const job of jobs) {
      const data = job.data;
      const jobRowId = data.__jobRowId;
      const leadId = (data as { leadId?: string }).leadId;
      const log = logger.child({ job_id: jobRowId, lead_id: leadId, type });

      // Mark active (and bump the attempt counter) for the monitor.
      if (jobRowId) await markJob(jobRowId, 'active', { bumpAttempt: true });
      try {
        await handler(data);
        if (jobRowId) await markJob(jobRowId, 'completed');
        log.info('job completed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Record the failure; pg-boss decides retry vs dead-letter from here.
        // A successful retry overwrites this row back to completed; an exhausted
        // one is marked `dead` by the dead-letter consumer.
        if (jobRowId) await markJob(jobRowId, 'failed', { error: message });
        log.error('job failed', { err: message });
        throw err; // re-throw so pg-boss applies its retry policy
      }
    }
  };
}
