import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root. A stray package-lock.json in a parent directory
  // otherwise makes Next infer the wrong root, which breaks chunk/module
  // resolution (the "__webpack_modules__ / Cannot find module './437.js'" errors).
  outputFileTracingRoot: repoRoot,
  // Linting is centralized at the monorepo root (`pnpm lint`), so the Next build
  // doesn't re-run it over the shared flat config.
  eslint: { ignoreDuringBuilds: true },
  // The web app is a thin operator UI over the API; no server-side secrets.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
