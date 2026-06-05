import './load-env'; // MUST be first — loads .env before any DB/env access.
import { serve } from '@hono/node-server';
import { ensureExampleTable, getEnv, logger, startQueues, stopQueues } from '@fetch/core';
import { closeDb } from '@fetch/db';
import { app } from './app';

/**
 * API entrypoint. The API is the system's one front door: it validates input,
 * writes a row, and enqueues a job — it NEVER does slow/network work itself.
 * Starting the queue here lets routes enqueue; workers run in a separate process.
 */
async function main() {
  const env = getEnv();

  // Connect to the in-Postgres queue so routes can enqueue jobs.
  await startQueues();

  // Seed the protected example table once on boot. Non-fatal: a fresh DB without
  // migrations, or a transient error, must never stop the API from listening.
  try {
    await ensureExampleTable();
  } catch (err) {
    logger.warn('ensureExampleTable failed (continuing)', { err: String(err) });
  }

  const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info('api listening', { port: info.port });
  });

  // Graceful shutdown: drain the queue connection and the DB pool.
  const shutdown = async () => {
    logger.info('api shutting down');
    server.close();
    await stopQueues();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('api failed to start', { err: String(err) });
  process.exit(1);
});
