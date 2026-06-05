#!/usr/bin/env bash
#
# Fetch — one-command local dev.
#
# Brings the whole stack up from nothing:
#   1. ensures a .env exists (copied from .env.example if missing)
#   2. starts a Postgres container (queue lives inside it — no Redis)
#   3. installs deps, applies migrations, optionally seeds demo data
#   4. runs api (:4000) + worker + web (:3000) together
#
# Usage:
#   scripts/dev.sh              # full bootstrap + run
#   PG_PORT=5432 scripts/dev.sh # use a different host port for Postgres
#   SEED=0 scripts/dev.sh       # skip seeding demo data
#   scripts/dev.sh setup        # bootstrap only (no processes started)
#
# Ctrl-C stops all three processes cleanly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PG_PORT="${PG_PORT:-5433}"
PG_CONTAINER="${PG_CONTAINER:-fetch-pg}"
SEED="${SEED:-1}"
MODE="${1:-run}"

log() { printf '\033[36m[dev]\033[0m %s\n' "$*"; }

# ── 1. .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  log "creating .env (DATABASE_URL on port ${PG_PORT})"
  sed "s|^DATABASE_URL=.*|DATABASE_URL=postgres://fetch:fetch@localhost:${PG_PORT}/fetch|" \
    .env.example > .env
fi

# Export everything in .env so the per-package processes inherit it (pnpm runs
# filtered scripts from each package dir, where a bare dotenv wouldn't find it).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# ── 2. Postgres ───────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "ERROR: docker not found. Install Docker, or point DATABASE_URL at your own Postgres."
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  log "starting existing Postgres container '${PG_CONTAINER}'"
  docker start "${PG_CONTAINER}" >/dev/null
else
  log "launching Postgres on host port ${PG_PORT}"
  docker run -d --name "${PG_CONTAINER}" \
    -e POSTGRES_USER=fetch -e POSTGRES_PASSWORD=fetch -e POSTGRES_DB=fetch \
    -p "${PG_PORT}:5432" postgres:18 >/dev/null
fi

log "waiting for Postgres to accept connections..."
for _ in $(seq 1 30); do
  if docker exec "${PG_CONTAINER}" pg_isready -U fetch -d fetch >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# ── 3. install + migrate + seed ───────────────────────────────────────────────
log "installing dependencies"
pnpm install

log "applying migrations"
pnpm db:migrate

if [ "${SEED}" = "1" ]; then
  log "seeding demo data (set SEED=0 to skip)"
  pnpm seed || log "seed skipped/failed (non-fatal)"
fi

if [ "${MODE}" = "setup" ]; then
  log "bootstrap complete. Start the app with: scripts/dev.sh"
  exit 0
fi

# ── 4. run the three processes together ───────────────────────────────────────
log "starting api (:${API_PORT:-4000}), worker, and web (:3000) — Ctrl-C to stop"
# Kill the whole process group on exit so all three stop together.
trap 'log "shutting down"; kill 0' EXIT INT TERM

pnpm dev:api &
pnpm dev:worker &
pnpm dev:web &
wait
