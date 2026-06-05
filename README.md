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

```bash
# 1. Configure
cp .env.example .env          # only DATABASE_URL is required to boot

# 2. Start Postgres (queue lives inside it — no Redis)
docker compose -f infra/docker-compose.yml up -d postgres

# 3. Install + migrate + seed
pnpm install
pnpm db:migrate
pnpm seed                     # optional: demo columns, a prompt, sample leads

# 4. Run the three processes (separate terminals)
pnpm dev:api                  # http://localhost:4000  (front door)
pnpm dev:worker               # pg-boss consumers (the slow work)
pnpm dev:web                  # http://localhost:3000  (operator UI)
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
| `scripts/backup.sh` | `pg_dump` the whole DB (a complete snapshot). |

## License

MIT.
