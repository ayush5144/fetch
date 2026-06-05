import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Side-effect module: load .env BEFORE anything that reads env. ES module
 * imports are evaluated in order, so importing this first (before @fetch/db et
 * al.) guarantees DATABASE_URL is set when the DB pool initializes.
 *
 * Loads the current dir's .env, then falls back to the monorepo root — pnpm
 * runs this filtered script from apps/api, where a bare dotenv would miss the
 * root .env. dotenv never overrides already-set vars, so a shell export wins.
 */
loadEnv();
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });
