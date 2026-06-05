import PgBoss from 'pg-boss';
import { getEnv } from '../env';
import { logger } from '../logger';

/**
 * The job queue lives INSIDE Postgres via pg-boss (FOR UPDATE SKIP LOCKED
 * dequeue), which is what removes Redis from the deploy: the self-host baseline
 * is one database + the app.
 *
 * This module owns the single PgBoss instance and the list of queues. The API
 * uses it to enqueue; the worker uses it to consume.
 */

/** The five work queues, matching the worker handler set. */
export const QUEUES = {
  enrich: 'enrich',
  validate: 'validate',
  personalize: 'personalize',
  send: 'send',
  event: 'event',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Retry policy applied to every queue: backoff with jitter, then dead-letter. */
const RETRY_POLICY = {
  retryLimit: 5,
  retryBackoff: true, // exponential backoff with built-in jitter
  retryDelay: 5, // seconds before the first retry
} as const;

let boss: PgBoss | null = null;

/** Lazily construct (and cache) the PgBoss instance bound to our Postgres. */
export function getBoss(): PgBoss {
  if (boss) return boss;
  const env = getEnv();
  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Keep completed/failed job rows briefly for the monitor to read, then GC.
    retentionDays: 7,
  });
  boss.on('error', (err) => logger.error('pg-boss error', { err: String(err) }));
  return boss;
}

/**
 * Start the queue and ensure every queue exists with its retry + dead-letter
 * policy. Idempotent: createQueue is a no-op if the queue already exists, so
 * both the API and the worker can call this safely on boot.
 */
export async function startQueues(): Promise<PgBoss> {
  const b = getBoss();
  await b.start();
  for (const name of Object.values(QUEUES)) {
    // The dead-letter queue must exist BEFORE the main queue references it
    // (pg-boss enforces this with a foreign key).
    await b.createQueue(`${name}.dead`);
    await b.createQueue(name, {
      name,
      ...RETRY_POLICY,
      // Terminal failures route to a per-queue dead-letter for inspect/replay.
      deadLetter: `${name}.dead`,
    });
  }
  logger.info('queues ready', { queues: Object.values(QUEUES) });
  return b;
}

/** Stop the queue cleanly on shutdown. */
export async function stopQueues(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = null;
  }
}
