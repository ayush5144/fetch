import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { closeDb, db } from './client';

/**
 * Applies all pending migrations from ./migrations, then exits. Drizzle tracks
 * what has run in its own metadata table, so re-running is a safe no-op — the
 * idempotency the checklist asks for.
 */
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../migrations');

  console.log(`[db] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('[db] migrations up to date');
  await closeDb();
}

main().catch((err) => {
  console.error('[db] migration failed:', err);
  process.exit(1);
});
