import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * vitest globalSetup for the `db` project. Runs once before the integration
 * suite: points DATABASE_URL at the test database (TEST_DATABASE_URL wins, so a
 * dev DB is never clobbered) and applies migrations so the schema exists.
 * Individual tests reset state with `truncateAll()` from @fetch/db/testing.
 */
export default async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) to run db integration tests.');
  }

  // Import after DATABASE_URL is finalized so the pool binds to the right DB.
  const { db, closeDb } = await import('@fetch/db');
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../packages/db/migrations');

  await migrate(db, { migrationsFolder });
  await closeDb();
}
