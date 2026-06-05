import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

/**
 * Two test projects:
 *  - `unit` — pure-function / mock-based tests. No database, fully parallel.
 *  - `db`   — integration tests (`*.db.test.ts`) against one disposable Postgres,
 *             run serially. global-setup points DATABASE_URL at the test DB and
 *             applies migrations.
 *
 * `pnpm test` runs both; `pnpm test:unit` / `pnpm test:db` run one.
 */

const r = (p: string) => resolve(import.meta.dirname, p);

// Map every workspace package to its `src` entry so a test can import any
// @fetch/* package regardless of which package the test file lives in.
// Subpath aliases (db/testing, db/schema) MUST precede the bare alias.
const alias = {
  '@fetch/db/testing': r('packages/db/src/testing.ts'),
  '@fetch/db/schema': r('packages/db/src/schema/index.ts'),
  '@fetch/db': r('packages/db/src/index.ts'),
  '@fetch/core': r('packages/core/src/index.ts'),
  '@fetch/connectors': r('packages/connectors/src/index.ts'),
  '@fetch/columns': r('packages/columns/src/index.ts'),
  '@fetch/enrichment': r('packages/enrichment/src/index.ts'),
  '@fetch/agent': r('packages/agent/src/index.ts'),
  '@fetch/llm': r('packages/llm/src/index.ts'),
  '@fetch/validation': r('packages/validation/src/index.ts'),
  '@fetch/personalization': r('packages/personalization/src/index.ts'),
  '@fetch/senders': r('packages/senders/src/index.ts'),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      include: ['{packages,apps}/*/test/**/*.test.ts'],
      exclude: ['**/*.db.test.ts', '**/node_modules/**'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'db',
      environment: 'node',
      include: ['{packages,apps}/*/test/**/*.db.test.ts'],
      exclude: ['**/node_modules/**'],
      globalSetup: ['./test/global-setup-db.ts'],
      // All db tests share ONE Postgres. A single fork runs them serially so no
      // two files touch the database at once; isolate keeps each file's module
      // state (and any vi.mock) clean.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true } },
      sequence: { concurrent: false },
      testTimeout: 20_000,
    },
  },
]);
