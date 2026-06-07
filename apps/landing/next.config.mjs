import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Next doesn't infer the wrong one from a stray
  // lockfile in a parent directory (which breaks chunk/module resolution).
  outputFileTracingRoot: repoRoot,
  // Linting is centralized at the monorepo root (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
