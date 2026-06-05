#!/usr/bin/env bash
# Minimal deploy: pull, install, build, migrate, restart. Idempotent — safe to
# re-run on a host. Migrations are no-ops when already applied.
set -euo pipefail

echo "[deploy] pulling latest"
git pull --ff-only

echo "[deploy] installing"
pnpm install --frozen-lockfile=false

echo "[deploy] building"
pnpm build

echo "[deploy] migrating"
pnpm db:migrate

echo "[deploy] restarting services (docker compose)"
docker compose -f infra/docker-compose.yml up -d --build

echo "[deploy] done"
