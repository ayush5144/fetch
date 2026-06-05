/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is centralized at the monorepo root (`pnpm lint`), so the Next build
  // doesn't re-run it over the shared flat config.
  eslint: { ignoreDuringBuilds: true },
  // The web app is a thin operator UI over the API; no server-side secrets.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
