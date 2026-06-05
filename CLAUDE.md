# CLAUDE.md — Fetch

Open-source, self-hostable **Clay**: a multi-table workspace where a column is a
reusable job and a customizable agent (**Dogi**) fills any cell — using your keys
or ours. One canonical lead in Postgres; ingest → enrich → validate → personalize
→ send → learn.

## Where things are

- **Checklist (operational state):** `dev_notes/CHECKLIST_fetch.md`
  - Part I (Phases 0–12) = the built MVP backend. Part II (Phases A–H) = the
    current Clay/Dogi direction. `[ ]` = todo, `[x]` = done. Done means done.
- **Architecture (reference):** `dev_notes/ARCHITECTURE_fetch.md`, `dev_notes/PRD.md`,
  `dev_notes/WORKING.md`, and `docu.md` (as-built).
- **Forward design (the new direction):** `devx/` — read these before building
  Part II: `direction.md`, `doggo.md` (the two-agent architecture —
  **Dogi** cell primitive vs **Doggo** autonomous orchestrator), `dogi-agent.md`,
  `leads-grid.md`, `multi-table.md`, `providers-and-keys.md`,
  `dedupe-and-accounts.md`, `mcp.md`, `roadmap.md`.

## Stack

pnpm monorepo · TypeScript · Postgres 18 · pg-boss (queue in Postgres, no Redis)
· Drizzle ORM · Hono API · Next.js App Router UI. Layout:
`apps/{api,worker,web}` + `packages/{db,core,connectors,columns,enrichment,agent,llm,validation,personalization,senders}`.

## Locked decisions (do not revisit)

1. **Postgres is the single source of truth.** Enrich in place; never a parallel
   `enriched_leads` table. History lives in `audit_log`.
2. **The API never does slow work** — it writes a row and enqueues a job; workers
   do enrichment/validation/personalization/sending.
3. **Everything external is behind an interface** — LLM providers, enrichment
   data providers, send rails. The core never learns a vendor's shape.
4. **Provenance on every Dogi cell** — value + confidence + source.
5. **Validation gates sending; approval gates sending.** Never auto-send.
6. **Multi-table:** leads + columns are scoped by `table_id`; `columns.key`/`label`
   unique per table. Default table id = `tbl_default_leads`.
7. **Dogi = enrichment.** One `dogi` column type (formerly enrichment+agent);
   `formula` + `manual` stay separate. Dogi has **optional, configurable sources**
   (data provider · web search [native|external] · scrape · LLM) + a `combine`
   (default) / `first` policy; `brain` (LLM) is optional. One data provider at a
   time for now.
8. **BYOK + env keys both.** BYOK keys are never persisted server-side or logged.
9. **No secrets in code or logs; webhooks verify signatures; public endpoints
   rate-limited.** Two columns in a table never share a name.
10. **Keep tests green:** `pnpm typecheck && pnpm lint && pnpm test` per phase.
    UI stays consistent with the existing design tokens in
    `apps/web/app/globals.css` (navy ink + coral accent).

## Verifying

`pnpm typecheck` · `pnpm lint` · `pnpm test:unit` (no DB) · `pnpm test` (needs
`TEST_DATABASE_URL`, a throwaway Postgres). Dev DB runs on host port 5433; the
test DB on 5434.

## Current state

Part I shipped (169-test backend). Part II: **Phase A (multi-table) done.** Next
up: B (Clay grid), C (Dogi + providers), D (goal mode), E (saved/cost/test-5),
G (optional dedupe), F/H (stretch: visual flow, MCP).
