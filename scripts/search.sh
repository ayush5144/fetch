#!/usr/bin/env bash
#
# Fetch — OPT-IN search & scrape stack helper.
#
# This is NOT part of the baseline boot. scripts/dev.sh stays Postgres-only.
# This brings up the optional self-hosted search (OpenSERP) and scrape
# (Firecrawl) services defined in docker-compose.search.yml.
#
# Usage:
#   scripts/search.sh up           # start everything (OpenSERP + Firecrawl)
#   scripts/search.sh up-openserp  # start only OpenSERP (light; no Firecrawl)
#   scripts/search.sh down         # stop & remove the stack
#   scripts/search.sh status       # docker ps for the fetch-* search containers
#   scripts/search.sh smoke        # live curl smoke for both services
#
# After `up`, point the app at the services (see .env.example):
#   OPENSERP_URL=http://localhost:7001
#   OPENSERP_ENGINE=yandex
#   FIRECRAWL_API_URL=http://localhost:3002
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.search.yml)
CMD="${1:-up}"

case "$CMD" in
  up)
    "${COMPOSE[@]}" up -d
    echo "Search stack starting. Firecrawl API can take ~30-60s to be ready."
    echo "Verify:  scripts/search.sh smoke"
    ;;
  up-openserp)
    "${COMPOSE[@]}" up -d openserp
    ;;
  down)
    "${COMPOSE[@]}" down
    ;;
  status)
    docker ps --filter 'name=fetch-openserp' --filter 'name=fetch-firecrawl' \
      --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    ;;
  smoke)
    echo "== OpenSERP (Yandex) =="
    curl -s "http://localhost:7001/${OPENSERP_ENGINE:-yandex}/search?text=anthropic+claude&lang=EN&limit=2" \
      -w '\nHTTP %{http_code}\n' || true
    echo
    echo "== Firecrawl scrape example.com =="
    curl -s -X POST http://localhost:3002/v1/scrape \
      -H 'Content-Type: application/json' \
      -d '{"url":"https://example.com","formats":["markdown"]}' \
      -w '\nHTTP %{http_code}\n' || true
    ;;
  *)
    echo "usage: scripts/search.sh {up|up-openserp|down|status|smoke}" >&2
    exit 1
    ;;
esac
