#!/usr/bin/env bash
# Daily backup: a single pg_dump of the whole database. Because Postgres is the
# single source of truth — leads, jobs, events, everything — one dump is a
# complete, restorable snapshot. Restore with:
#   psql "$DATABASE_URL" < backups/fetch-YYYYmmdd-HHMMSS.sql
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/fetch-${STAMP}.sql"

echo "[backup] dumping to ${OUT}"
pg_dump "${DATABASE_URL}" > "${OUT}"
echo "[backup] done ($(du -h "${OUT}" | cut -f1))"
