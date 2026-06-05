import './load-env'; // MUST be first — loads .env before any DB/queue access.
import { getEnv, getBoss, logger, markJob, QUEUES, startQueues, stopQueues } from '@fetch/core';
import { closeDb } from '@fetch/db';
import { enrichHandler } from './handlers/enrich';
import { eventHandler } from './handlers/event';
import { personalizeHandler } from './handlers/personalize';
import { sendHandler } from './handlers/send';
import { validateHandler } from './handlers/validate';
import { wrap } from './runner';

/**
 * Worker entrypoint. A separate process from the API so slow/failable work
 * scales independently and never blocks the front door. Each queue gets a typed
 * handler, wrapped with the shared runner that mirrors job state into the
 * `jobs` table and applies structured logging.
 *
 * Concurrency comes from pg-boss claiming jobs with FOR UPDATE SKIP LOCKED, so
 * running multiple worker processes drains one queue safely — no job is ever
 * processed twice.
 */
async function main() {
  const env = getEnv();
  await startQueues();
  const boss = getBoss();

  const teamSize = env.WORKER_CONCURRENCY;
  const opts = { batchSize: 1, teamSize, teamConcurrency: teamSize };

  await boss.work(QUEUES.enrich, opts, wrap('enrich', enrichHandler));
  await boss.work(QUEUES.validate, opts, wrap('validate', validateHandler));
  await boss.work(QUEUES.personalize, opts, wrap('personalize', personalizeHandler));
  await boss.work(QUEUES.send, opts, wrap('send', sendHandler));
  await boss.work(QUEUES.event, opts, wrap('event', eventHandler));

  // Dead-letter consumers: when a job exhausts its retries, pg-boss routes it to
  // `${queue}.dead`. We mark the observable jobs row `dead` so the monitor can
  // surface it for inspection / replay.
  for (const q of Object.values(QUEUES)) {
    await boss.work(`${q}.dead`, async (jobs: { data: { __jobRowId?: string } }[]) => {
      for (const job of jobs) {
        if (job.data.__jobRowId) {
          await markJob(job.data.__jobRowId, 'dead', { error: 'retries exhausted' });
        }
      }
    });
  }

  logger.info('worker online', { concurrency: teamSize, queues: Object.values(QUEUES) });

  const shutdown = async () => {
    logger.info('worker shutting down');
    await stopQueues();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('worker failed to start', { err: String(err) });
  process.exit(1);
});
