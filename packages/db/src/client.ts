import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * A single pooled Postgres client shared across the API and workers.
 *
 * One pool per process is intentional: the API stays responsive and workers
 * scale by process, not by opening unbounded connections. The `db` export is
 * the Drizzle handle every package queries through.
 */

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail fast with a clear message rather than a confusing connection error.
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres.',
    );
  }
  return url;
}

export const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export { schema };

/** Liveness check used by GET /health — a trivial round-trip to Postgres. */
export async function pingDb(): Promise<boolean> {
  const res = await pool.query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

/** Close the pool cleanly on shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}
