import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — drives migration generation and `drizzle-kit studio`.
 * Migrations are versioned SQL under ./migrations and applied by src/migrate.ts.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://fetch:fetch@localhost:5432/fetch',
  },
  verbose: true,
  strict: true,
});
