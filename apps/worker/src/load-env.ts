import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Side-effect module: load .env BEFORE anything that reads env. Imported first
 * in index.ts so DATABASE_URL is set when the DB pool / queue initialize.
 * Loads the current dir's .env, then the monorepo root as a fallback (pnpm runs
 * this filtered script from apps/worker). dotenv never overrides set vars.
 */
loadEnv();
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });
