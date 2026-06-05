# Fetch

**An open-source, self-hostable GTM operating system.**

A lead enters once and Fetch owns its whole life — ingest → enrich → validate →
personalize → send → learn — as operations on **one canonical record** in
Postgres. Think Clay (a table you operate from, waterfall enrichment, AI
research per cell), made self-hostable and extended downstream into sending.
Instantly and Smartlead are delivery rails behind an adapter, not the product.

> The one rule everything bends around: **Postgres is the single source of
> truth.** Every layer reads from it and writes back to it.

---

## Quickstart (self-host)

The minimum viable deploy is **one Postgres + the app**. No Redis, no broker.

### One command

```bash
scripts/dev.sh
```

It creates `.env` if missing, starts Postgres in Docker (host port **5433**, so it
won't clash with an existing Postgres on 5432), installs, migrates, seeds demo
data, then runs the API (`:4000`), worker, and web UI (`:3000`) together. Ctrl-C
stops all three. Useful knobs:

```bash
PG_PORT=5432 scripts/dev.sh    # use a different Postgres host port
SEED=0       scripts/dev.sh    # skip demo data
scripts/dev.sh setup           # bootstrap only, don't start the processes
```

### Manual (three terminals)

```bash
cp .env.example .env           # only DATABASE_URL is required to boot
docker run -d --name fetch-pg -e POSTGRES_USER=fetch -e POSTGRES_PASSWORD=fetch \
  -e POSTGRES_DB=fetch -p 5433:5432 postgres:18   # set DATABASE_URL to :5433
pnpm install && pnpm db:migrate && pnpm seed
pnpm dev:api                   # http://localhost:4000  (front door)
pnpm dev:worker                # pg-boss consumers (the slow work)
pnpm dev:web                   # http://localhost:3000  (operator UI)
```

Open <http://localhost:3000>, import a CSV, add a column, and run it.

To run the whole stack in containers instead:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

---

## What's in the box

| Path | What it is |
|---|---|
| `apps/api` | The front door (Hono). Writes rows, enqueues jobs, takes webhooks. **Never does slow work.** |
| `apps/worker` | pg-boss consumers: enrich · validate · personalize · send · event. |
| `apps/web` | Table-first operator UI (Next.js). |
| `packages/db` | Drizzle schema + client — the tables, the single source of truth. |
| `packages/core` | Env, queue, dedupe/ingestion, audit, logging. |
| `packages/columns` | The dynamic column engine (a column = a reusable job). |
| `packages/enrichment` | Provider waterfall (cheapest first, stop on hit). |
| `packages/agent` | LLM tool-calling research loop (waterfall fallback). |
| `packages/validation` | syntax · MX · SMTP · disposable → the send gate. |
| `packages/personalization` | Prompt builder + guardrails. |
| `packages/senders` | Send adapters: Instantly · Smartlead · SMTP. |
| `packages/connectors` | CSV / manual normalizers → one canonical lead. |

See **[docu.md](./docu.md)** for the full architecture and how every piece fits.

---

## Scripts

| Command | Does |
|---|---|
| `pnpm db:migrate` | Apply migrations (idempotent). |
| `pnpm seed` | Seed demo data. |
| `pnpm typecheck` | Typecheck every workspace. |
| `pnpm build` | Build all packages + apps. |
| `pnpm test` | Run the full suite (unit + db). |
| `pnpm test:unit` | Pure-function / mock tests only (no DB). |
| `pnpm test:db` | Integration tests against `TEST_DATABASE_URL`. |
| `scripts/backup.sh` | `pg_dump` the whole DB (a complete snapshot). |

### Testing

Two projects: **unit** (fast, no DB) and **db** (integration against a real
Postgres). For the db suite, point `TEST_DATABASE_URL` at a throwaway database:

```bash
docker run -d --name fetch-test-pg -e POSTGRES_USER=fetch -e POSTGRES_PASSWORD=fetch \
  -e POSTGRES_DB=fetch_test -p 5434:5432 postgres:18
TEST_DATABASE_URL=postgres://fetch:fetch@localhost:5434/fetch_test pnpm test
```

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → build → test
on every push, with a Postgres service for the db project.

## License

MIT.
