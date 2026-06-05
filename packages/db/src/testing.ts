import { sql } from 'drizzle-orm';
import { db } from './client';

/**
 * Test-only helpers. These exist so integration tests can reset state between
 * cases without each test re-declaring the table list. Importing this module
 * binds to the same pool as the rest of the app (DATABASE_URL), which in the
 * `db` test project points at the disposable test database.
 */

/** Every table, child-first, so a CASCADE TRUNCATE is unambiguous. */
const ALL_TABLES = [
  'audit_log',
  'events',
  'jobs',
  'sequences',
  'leads',
  'columns',
  'campaigns',
  'prompts',
  'accounts',
  'sources',
] as const;

/** Wipe all domain data, resetting identities. Call in beforeEach. */
export async function truncateAll(): Promise<void> {
  await db.execute(
    sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`),
  );
}
