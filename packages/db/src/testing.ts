import { sql } from 'drizzle-orm';
import { db } from './client';

/**
 * Test-only helpers. These exist so integration tests can reset state between
 * cases without each test re-declaring the table list. Importing this module
 * binds to the same pool as the rest of the app (DATABASE_URL), which in the
 * `db` test project points at the disposable test database.
 */

import { DEFAULT_TABLE_ID } from './schema';

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
  'tables',
] as const;

/**
 * Wipe all domain data, resetting identities, then re-seed the default table so
 * table-scoped tests always have somewhere to put rows. Call in beforeEach.
 */
export async function truncateAll(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
  await db.execute(
    sql`INSERT INTO tables (id, name, description) VALUES (${DEFAULT_TABLE_ID}, 'Leads', 'Default table') ON CONFLICT (id) DO NOTHING`,
  );
}
