# Fetch 🐕

**Open-source, self-hostable Clay** — a multi-table workspace where every column is a
reusable job and a customizable AI agent fills any cell, using **your** keys or the
server's. A lead enters once and Fetch owns its whole life — ingest → enrich →
validate → personalize → send → learn — as operations on **one canonical record**
in Postgres.

[![License: MIT](https://img.shields.io/badge/License-MIT-coral.svg)](./LICENSE)
&nbsp;TypeScript · Postgres · Next.js · pg-boss (no Redis)

> The one rule everything bends around: **Postgres is the single source of truth.**
> Every layer reads from it and writes back to it. The API only writes a row and
> enqueues a job; workers do the slow work (LLMs, search, sending).

---

## Why Fetch

Clay is brilliant but closed and metered. Fetch is the same idea — a spreadsheet
you *operate*, waterfall enrichment, AI research per cell — made **fully
self-hostable** and extended downstream into validation and sending. Bring your
own LLM keys, run your own search, own your data.

## Features

- 🗂️ **Multi-table, spreadsheet-style grid** — create tables, add columns inline,
  edit any cell, drag/resize/reorder, import CSV with column mapping.
- 🐕 **Dogi — the cell agent.** A column is a saved Dogi that fills one field per
  row, with **provenance on every cell** (value + confidence + source URL).
  Configurable sources: data provider · web search · scrape · LLM, with a
  combine / stop-at-first policy.
- 🦴 **Bone — the orchestrator.** Describe a goal ("top 10 AI infra companies,
  their CEOs, and CEO LinkedIn URLs") and Bone **sources the rows**, **builds the
  columns** (each a Dogi), and runs them in dependency order. Review/edit the plan
  before it builds; re-run the whole flow as a unit (append-new / retry / replace).
- 🧠 **Four LLM providers + BYOK** — Anthropic · OpenAI · Gemini · Grok behind one
  interface. Default brain is a **web-search-capable** model (cited results out of
  the box); per-Dogi overridable; BYOK keys are never persisted.
- 🔎 **Self-hostable web search + scrape** — use the LLM's built-in search, or run
  your own **OpenSERP** (search) + **Firecrawl** (scrape) — no paid API keys.
- 🧹 **Optional dedupe** — per-table policy (none / by column(s) / by company),
  plus dedupe-existing rows from the column menu. Nothing is force-merged.
- ✅ **Validation gate** — syntax · MX · SMTP/mailbox reachability before sending.
- 📤 **Send rails behind an adapter** — Instantly · Smartlead · SMTP. Validation +
  approval gate sending; never auto-send.
- 🔌 **MCP server** — drive Fetch from an external AI client (Claude Desktop,
  Cursor…) over the Model Context Protocol; read-only by default.
- 🐘 **Postgres-only** — state, the job queue (pg-boss), and event history live in
  one database. No Redis, no broker. One command to run.

---

## The two agents

| | **Dogi** | **Bone** |
|---|---|---|
| What it is | the **cell / column** agent | the **table orchestrator** |
| Scope | fills **one field** for one row (web-search → scrape → answer) | plans a goal: **sources rows + builds many columns**, runs them in order |
| Column-specific? | yes — one Dogi = one column | no — it operates the whole table; each column it makes is a Dogi |

Full design: [`devx/dogi-agent.md`](./devx/dogi-agent.md) · [`devx/bone.md`](./devx/bone.md).

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

Open <http://localhost:3000>, create a table, import a CSV or click **Ask Bone**,
and watch it build + fill columns. Add a provider key (below) to light up the AI.

---

## Configuration

Everything is optional except `DATABASE_URL` (see `.env.example`):

```bash
DATABASE_URL=postgres://fetch:fetch@localhost:5433/fetch   # required

# LLM (enables Dogi/Bone). The default model has built-in web search.
LLM_PROVIDER=openai            # anthropic | openai | gemini | grok
LLM_MODEL=gpt-4o-mini-search-preview
OPENAI_API_KEY=...             # and/or ANTHROPIC_API_KEY / GEMINI_API_KEY / GROK_API_KEY

# Self-hosted search + scrape (optional — see devx/RUN-search-stack.md)
OPENSERP_URL=                  # e.g. http://localhost:7001
FIRECRAWL_API_URL=             # e.g. http://localhost:3002

# Send rails (optional): INSTANTLY_API_KEY / SMARTLEAD_API_KEY / SMTP_*
FETCH_API_TOKEN=               # optional bearer; empty = open (single-tenant)
```

Users can also bring keys per-Dogi (**BYOK**) in the UI — those are never stored
server-side. Run the optional search stack with `scripts/search.sh up`.

---

## What's in the box

| Path | What it is |
|---|---|
| `apps/api` | The front door (Hono). Writes rows, enqueues jobs, takes webhooks. **Never does slow work.** |
| `apps/worker` | pg-boss consumers: enrich · validate · personalize · send · event. |
| `apps/web` | Table-first operator UI (Next.js). A pure HTTP client. |
| `apps/mcp` | Model Context Protocol server — Fetch as an agent-operable product. |
| `packages/db` | Drizzle schema + client — the tables, the single source of truth. |
| `packages/core` | Env, queue, dedupe/ingestion, audit, logging. |
| `packages/columns` | The dynamic column engine (a column = a reusable job). |
| `packages/agent` | Dogi (cell agent) + Bone (orchestrator): research loop, planner, row sourcing. |
| `packages/llm` | Provider-agnostic LLM client (Anthropic/OpenAI/Gemini/Grok) + web search. |
| `packages/enrichment` | Provider waterfall (cheapest first, stop on hit). |
| `packages/validation` | syntax · MX · SMTP · disposable → the send gate. |
| `packages/personalization` | Prompt builder + guardrails. |
| `packages/senders` | Send adapters: Instantly · Smartlead · SMTP. |
| `packages/connectors` | CSV / manual normalizers → one canonical lead. |

See **[docu.md](./docu.md)** for the as-built architecture, and **[devx/](./devx/)**
for the forward design (Dogi/Bone, multi-table, search & scrape, MCP).

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
| `scripts/search.sh up` | Start the optional self-hosted search stack (OpenSERP + Firecrawl). |
| `scripts/backup.sh` | `pg_dump` the whole DB (a complete snapshot). |

### Testing

Two projects: **unit** (fast, no DB) and **db** (integration against a real
Postgres). For the db suite, point `TEST_DATABASE_URL` at a throwaway database:

```bash
docker run -d --name fetch-test-pg -e POSTGRES_USER=fetch -e POSTGRES_PASSWORD=fetch \
  -e POSTGRES_DB=fetch_test -p 5434:5432 postgres:18
TEST_DATABASE_URL=postgres://fetch:fetch@localhost:5434/fetch_test pnpm test
```

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → build → test on
every push, with a Postgres service for the db project.

---

## Deploying

- **Frontend (Vercel):** `vercel.json` scopes the build to `apps/web` only (a pure
  HTTP client). Set `NEXT_PUBLIC_API_URL` to your API's URL.
- **Backend (API + worker):** any container host / VM with Postgres. The API and
  worker share one `DATABASE_URL`; scale workers horizontally (pg-boss uses
  `SELECT … FOR UPDATE SKIP LOCKED`).

---

## Contributing

Issues and PRs welcome. Before a PR: `pnpm typecheck && pnpm lint && pnpm test`
(green). The repo is a pnpm monorepo — keep changes scoped, match the existing
design tokens in `apps/web/app/globals.css`, and add a test for behavior changes.
Architecture & decisions live in `dev_notes/` and `devx/`.

## License

[MIT](./LICENSE) © 2026 Ayush Patil.
