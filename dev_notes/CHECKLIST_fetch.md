# Fetch Build Checklist

Operational checklist for phased builds. Keep this file current. Do not mix long notes here; use `ARCHITECTURE.md` for reference.

## ✅ Phase 0 - Product And Architecture Decisions

- [x] Lock product to an open-source, self-hostable GTM OS: ingest → enrich → validate → personalize → send → learn, on one canonical lead
- [x] Lock positioning: Clay is the enrichment reference; Instantly and Smartlead are delivery integrations behind an adapter, not the core
- [x] Lock Postgres as the single source of truth; enrich in place, never a parallel `enriched_leads` table
- [x] Lock stack: TypeScript monorepo, Postgres 18, pg-boss job queue (no Redis), Drizzle ORM, Next.js App Router UI, provider-agnostic LLM layer
- [x] Lock the hybrid column model: fixed system columns the engine gates on, plus user columns in `leads.data` (JSONB)
- [x] Document the nine core objects: leads, accounts, campaigns, sequences, jobs, events, prompts, sources, audit_log
- [x] Document enrichment rules: waterfall stop-on-first-hit, run-only-if-empty, store confidence + provenance per cell
- [x] Define the send adapter contract: `push(leads, campaign)` and `parseEvent(payload)`
- [x] Create the ARCHITECTURE.md reference doc

## Phase 1 - Project Foundation And Tooling

- [x] Scaffold monorepo: `apps/api`, `apps/worker`, `apps/web`, `packages/db`, `packages/core`
  - Test: `npm run typecheck`, `npm run lint`, and `npm run build` run across workspaces or missing scripts are documented.
- [x] Add `docker-compose.yml` with Postgres 18 only (no Redis)
  - Test: `docker compose up` starts Postgres and the API connects to it.
- [x] Configure Drizzle and migration tooling in `packages/db`
  - Test: `npm run migrate` runs on a fresh DB and re-running is a no-op (idempotent).
- [x] Add pg-boss singleton in `packages/core` against the same Postgres
  - Test: boss connects and creates its schema on first boot.
- [x] Add `.env.example` listing DB, LLM, and provider keys
  - Test: app fails fast with a clear error when a required env var is missing.
- [x] Add `GET /health` endpoint with a DB connectivity check
  - Test: returns 200 with `db: ok`; returns 503 when Postgres is down.
- [x] Set up CI: install → typecheck → lint → test on push
  - Test: CI passes green on a clean checkout.

## Phase 2 - Canonical Data Model, Ingestion, Dedupe

- [x] Write migrations for all core tables from `ARCHITECTURE.md`
  - Test: `npm run migrate` creates leads, accounts, sources, columns, jobs, events, campaigns, sequences, prompts, audit_log.
- [x] Add `leads.data` JSONB column with a GIN index
  - Test: a filter query on a `data` key uses the GIN index (`EXPLAIN` shows index scan).
- [x] Define a `Normalizer` interface mapping any source to a CanonicalLead
  - Test: the same person from CSV and from manual entry produces an identical canonical shape.
- [x] Build the CSV connector with header → field mapping
  - Test: importing a 100-row CSV creates 100 leads with mapped fields; unmapped columns land in `data`.
- [x] Build manual single-lead create and a stub API/webhook ingest endpoint
  - Test: `POST /leads` creates one canonical lead and returns its id.
- [x] Implement dedupe on email (lead) and domain (account)
  - Test: re-importing the same CSV creates 0 duplicate leads; two leads at one company share one accounts row.
- [x] Store the raw payload on every import in `sources.raw`
  - Test: each import writes a sources row containing the original payload.
- [x] Write to `audit_log` on every create and update
  - Test: a create and an update each produce an audit_log entry with a diff.
- [x] Handle a lead with no email without crashing the batch
  - Test: a no-email row imports with a status reflecting it; the rest of the batch still completes.

## Phase 3 - Job System And Worker Pool

- [x] Create pg-boss queues: enrich, validate, personalize, send, event
  - Test: each queue is registered and visible on worker boot.
- [x] Configure retryLimit, retryBackoff with jitter, and a dead-letter queue per queue
  - Test: a handler that always throws is retried then lands in dead-letter after the limit.
- [x] Build the worker process with typed handlers per queue
  - Test: enqueue a job → a worker claims and completes it; `jobs.status` transitions queued → active → completed.
- [x] Mirror job state into the `jobs` table for the UI
  - Test: every job has type, status, attempts, error, and timestamps populated.
- [x] Make every handler idempotent, keyed on lead_id + job type
  - Test: re-running a completed job produces no duplicate side effects.
- [x] Build a job-monitor API: list, filter, view error, retry, inspect dead-letter
  - Test: the retry endpoint re-enqueues a dead-lettered job and it can succeed.
- [x] Verify concurrency safety across multiple workers
  - Test: two worker processes drain one queue with no job processed twice (SELECT ... FOR UPDATE SKIP LOCKED).
- [x] Add structured logging with job_id and lead_id correlation
  - Test: logs for one job can be filtered by its job_id.

## Phase 4 - Dynamic Columns Engine

- [x] Build CRUD for the `columns` table: key, label, type, config
  - Test: creating a column persists it and it appears on reload.
- [x] Enforce the system-vs-user split
  - Test: system fields stay typed columns; user columns write only to `leads.data`.
- [x] Implement column types: enrichment, agent, formula, manual
  - Test: each type can be created and stores its config (provider order / prompt / formula).
- [x] Implement "Run column" fan-out respecting filters and selection
  - Test: running a column over a 50-row filter creates exactly 50 jobs, not whole-table.
- [x] Implement run-only-if-empty
  - Test: re-running a column skips already-filled cells and the job count drops.
- [x] Store per-cell `{ value, confidence, source_url }`
  - Test: each filled cell exposes a confidence value and a clickable source URL.
- [x] Implement formula recompute on dependency change
  - Test: editing an input cell recomputes the dependent formula column.
- [x] Implement manual column inline edit (no job)
  - Test: typing a value into a manual cell persists without enqueuing a job.
- [x] Handle column deletion safely
  - Test: deleting a column removes its definition without corrupting other `data` keys.

## Phase 5 - Enrichment (Waterfall + Agent Loop)

- [x] Define a `Provider` interface: `lookup(field, lead)` → value or null
  - Test: a mock provider can be registered and called by the waterfall.
- [x] Implement the waterfall with stop-on-first-hit in cost order
  - Test: when provider A returns a value, providers B and C are not called (asserted by call count).
- [x] Implement the agent loop fallback (LLM + tool calling)
  - Test: when all providers miss, the agent loop runs and fills the cell.
- [x] Wire tools: web_search (Serper/Brave), scrape_url (Firecrawl), extract_field (Firecrawl extract), browser_action (Playwright) for gated pages
  - Test: each tool is callable from the loop and a tool failure is handled, not fatal.
- [x] Enforce a step limit and per-job cost ceiling
  - Test: the agent aborts cleanly at the step limit with a partial result and no infinite loop.
- [x] Always write structured output plus confidence and source URL
  - Test: enriched cells store a value (not prose) and a reachable source URL.
- [x] Cache results per (field, company_domain) within a run
  - Test: a second lead at the same domain reuses the cached value with no new paid call.

## Phase 6 - Validation

- [x] Implement syntax check
  - Test: a malformed address returns `invalid` with no downstream SMTP call.
- [x] Implement MX record check
  - Test: a domain with no MX returns `invalid`.
- [x] Implement SMTP/mailbox reachability via Reacher
  - Test: an unreachable mailbox returns `risky` or `bounced`.
- [x] Implement disposable-domain detection
  - Test: a disposable domain (e.g. mailinator) returns `disposable`.
- [x] Implement catch-all handling per policy
  - Test: a catch-all domain returns `risky`, not `valid`.
- [x] Map results to the status enum and dedupe duplicates
  - Test: status is one of valid/risky/invalid/disposable/duplicate/no_email; a known duplicate returns `duplicate`.
- [x] Make `validation_status` the sending gate
  - Test: campaign eligibility excludes every non-valid status (opt-in risky only).

## Phase 7 - Personalization

- [x] Build the `prompts` table with versions and guardrails
  - Test: a prompt stores version plus guardrails (max length, required vars, banned claims).
- [x] Implement variable binding from lead, account, and `data`
  - Test: `{{first_name}}` and `{{recent_signal}}` resolve from real lead data.
- [x] Generate `{ subject, opener, body, cta }` and store the prompt_version used
  - Test: generated copy is written to the lead row with its prompt_version.
- [x] Run guardrail checks and flag failures for review
  - Test: an over-length or missing-variable output is flagged, not auto-approved.
- [x] Model approval states: draft → ready → approved → rejected
  - Test: approval transitions work and are recorded in audit_log.
- [x] Expose personalization as an agent column type
  - Test: a personalization column runs across rows like any other agent column.

## Phase 8 - Sending (Instantly Adapter First)

- [x] Implement the SendAdapter interface
  - Test: a mock adapter satisfies `push` and `parseEvent` and is selectable per campaign.
- [x] Implement the Instantly adapter against `POST /api/v2/leads`
  - Test: approved leads map to the correct payload with custom_variables present.
- [x] Batch sends into chunks of ≤1000 leads
  - Test: a 2500-lead campaign issues 3 batched requests.
- [x] Pass skip-duplicate and verify-on-import flags
  - Test: a lead already in the workspace is skipped per skip_if_in_workspace.
- [x] Persist provider_lead_id and send_status on success
  - Test: a sent lead stores provider_lead_id and send_status = sent.
- [x] Gate sending to approved + valid leads only
  - Test: a non-approved or non-valid lead is never sent.
- [x] Handle provider errors without losing the batch
  - Test: a rejected lead is recorded as failed while the rest of the batch proceeds.

## Phase 9 - Event Feedback (Webhooks)

- [x] Build webhook endpoints: `POST /webhooks/instantly`, `POST /webhooks/smartlead`
  - Test: both endpoints accept a sample payload and return 200 within the provider timeout.
- [x] Verify webhook signatures
  - Test: an unsigned or forged payload is rejected with 401/403.
- [x] Enforce idempotency via a unique provider_evt key
  - Test: the same event delivered twice creates exactly one events row.
- [x] ACK fast, then process asynchronously via an event job
  - Test: the endpoint returns 200 immediately under load while processing happens in a worker.
- [x] Normalize provider event names to the internal vocabulary
  - Test: Instantly and Smartlead names both map to sent/opened/clicked/replied/bounced/unsubscribed.
- [x] Match event to local lead by email/provider_lead_id
  - Test: a sparse Smartlead payload still resolves to the correct lead.
- [x] Update lead timestamps and campaign metrics
  - Test: a reply sets replied_at and increments the campaign reply metric.

## Phase 10 - Web UI (Table-First Workspace)

- [x] Build the lead table: filter, sort, inline edit, run-cell, run-column
  - Test: an operator triggers enrichment per row, per filter, and for the whole table.
- [x] Show value, confidence, and source link per cell
  - Test: a cell tooltip/expander shows confidence and a working source link.
- [x] Build the account view with company context and linked leads
  - Test: an account page lists every lead attached to its domain.
- [x] Build the campaign builder: template, rules, provider selection
  - Test: launching a campaign enqueues sends only for eligible leads.
- [x] Build the prompt editor with versions and guardrails
  - Test: editing a prompt creates a new version without overwriting approved copy.
- [x] Build the job monitor view
  - Test: job status, errors, retries, and dead-letter reflect real worker state.
- [x] Build the reply inbox from events
  - Test: replies, bounces, and unsubscribes appear as they arrive.
- [x] Build analytics: deliverability, engagement, conversion per campaign
  - Test: analytics numbers match the events table.
- [x] Make the table live without manual refresh
  - Test: a completed job or inbound event updates the visible row automatically.

## Phase 11 - Second Rail And Hardening

- [x] Implement the Smartlead adapter against the same SendAdapter interface
  - Test: a campaign sends via Smartlead with no changes to core/campaign code.
- [x] Respect Smartlead's rate limit (10 requests / 2 seconds)
  - Test: a large send stays under the limit with no 429 storm.
- [x] Add auth and, if multi-tenant, workspace scoping on every query
  - Test: a cross-tenant read is blocked.
- [x] Add observability: metrics, error tracking, per-job logs
  - Test: a forced failure surfaces in error tracking with its job_id.
- [x] Add the cross-cutting security pass
  - Test: no secrets in code or logs; all webhook endpoints verify signatures; public endpoints are rate-limited.
- [ ] (Optional) Add CRM connectors (HubSpot/Salesforce) for bidirectional sync
  - Test: a lead created in the CRM appears in Fetch and vice versa.

## Phase 12 - Deployment And Self-Host

- [x] Write self-host docs with a one-command bring-up
  - Test: a fresh machine reaches a working instance from the README alone.
- [x] Add a production env template
  - Test: required env names match the app code exactly.
- [x] Add a deploy script: pull, install, build, migrate, restart
  - Test: the deploy script exits 0 on a clean host.
- [x] Add a daily `pg_dump` backup script and a tested restore
  - Test: backup → wipe → restore recovers all leads and events intact.
- [x] Add uptime and error monitoring
  - Test: the monitor alerts on downtime and a test error appears in tracking.

## Ship Gate (MVP)

- [x] CSV → canonical lead with no duplicates
- [x] User can add a column and run it across rows
- [x] Enrichment fills cells with confidence + source (waterfall + agent)
- [x] Validation gates sending
- [x] Personalized copy is previewable and approvable
- [x] Approved leads send via Instantly
- [x] Replies/opens/bounces flow back into the same rows
- [x] The whole loop is operable from the UI
- [x] A second provider (Smartlead) works with no core changes
- [x] A stranger can self-host from the README

---

# Part II — Clay-style workspace + Dogi (next direction)

Builds on Phases 0–12 above; the existing backend (jobs, validation, sending,
events, self-host) stays green throughout. Design docs live in `../devx/`.
Each item has a **Test:** that defines done. Status: **not started** — planning
only; build after sign-off. Every phase ends with
`pnpm typecheck && pnpm lint && pnpm test` green.

## Phase A - Multi-Table Foundation

- [x] Add `tables` table (id, name, description?, icon?, timestamps)
  - Test: a migration creates `tables`; `npm run migrate` is idempotent.
- [x] Add `table_id` FK to `leads` and `columns`; backfill existing rows into one default "Leads" table; set NOT NULL
  - Test: every existing lead/column has a `table_id`; the default table holds them all.
- [x] Make `columns.key` unique per `(table_id, key)` instead of global
  - Test: two tables can each have a column keyed `company`; a dup within one table is rejected.
- [x] Tables CRUD API: `GET/POST/PATCH/DELETE /tables`
  - Test: create→list→rename→delete round-trips; deleting a table cascades its leads/columns.
- [x] Scope leads/columns endpoints by table (`GET /tables/:id/leads`, `/columns`)
  - Test: leads/columns return only the requested table's rows.
- [x] Overview lists tables (with counts) and creates a table + a lead
  - Test: creating a table in the UI shows it in Overview; "New lead" lands in the chosen table.
- [x] Job/event/audit references still resolve (they key on `lead_id`)
  - Test: a run on a lead in a non-default table still produces jobs/provenance.

## Phase B - The Clay Grid (Leads View)

- [x] Grid shell: row numbers, selection checkboxes, sticky header, horizontal scroll
  - Test: a 200-row table renders; selecting rows enables bulk actions.
- [x] Permanent trailing `+ Add column` header + inline create popover
  - Test: clicking `+` opens a popover anchored at the new column; creating adds the column inline.
- [x] Column types: a friendly picker — value types Text · Email · URL · Number · Date · Select · Checkbox, plus fill methods Dogi (AI) · Formula · Manual
  - Test: an Email column rejects a non-email; a Number column stores numbers; each type shows its icon.
- [x] Two columns in one table cannot share a name (label) or key
  - Test: creating/renaming to a duplicate name is rejected with a clear message.
- [x] Inline edit ANY field: click any row×column cell to edit in place; Enter saves, Esc cancels; type validation applies
  - Test: clicking an editable cell edits + persists; editing a computed (Dogi/formula) cell overrides it with an "edited" indicator.
- [x] Direct manipulation: drag to resize columns, drag to reorder columns, drag to reorder rows
  - Test: dragging column 3 between 1 and 2 persists the new order; a resize persists width; a row reorder persists.
- [x] Column header `⋯` menu: run · edit · rename · duplicate · insert left/right · delete
  - Test: each action works; delete removes the column def without corrupting other `data` keys.
- [x] Per-column `▷ Run` and per-cell hover `▷ Run`
  - Test: run-column fans out over visible/selected rows; run-cell enqueues one job.
- [x] Cell state machine: empty → queued → running → filled → error (derived from lead + live jobs)
  - Test: a running cell shows a spinner; completion shows value + confidence + source; failure shows the error + retry.
- [x] Inline `+ new lead` row
  - Test: adding a row then typing into a cell persists without a job (for manual/typed columns).
- [x] Cell side-peek: full value, provenance URL, which Dogi/model, "Re-run"
  - Test: opening a filled cell shows its source link and lets you re-run.
- [x] Live updates (poll) so completed runs/new rows appear without manual refresh
  - Test: a completed job updates the visible cell automatically.
- [x] Clean, non-technical UX: friendly type names, inline help, no jargon in create/select/run flows
  - Test: a first-time user adds a column and edits a cell without reading docs (usability check).

## Phase C - Dogi (Single Cell) And Providers

- [x] Unify `enrichment` + `agent` column types into a single `dogi` type (keep `formula`, `manual`, and the new value types)
  - Test: an existing enrichment column migrates to `dogi` with equivalent behavior.
- [x] Dogi config form: `instruction`, `reads`, `output`, `sources`, `policy`, `brain` (brain optional)
  - Test: the form persists a valid `dogi` config and reloads it for editing.
- [x] Output mapping: `create` new column (preview + confirm + audit) or `map` to existing
  - Test: "create" adds a new column before first run and audits it; "map" writes into the chosen existing key.
- [x] Sources are optional + selectable: data provider · web search · scrape · LLM (each toggleable anytime)
  - Test: a providers-only Dogi makes **no** LLM call; an LLM+web Dogi makes no provider call.
- [x] Data-provider integration — **one provider at a time for now** (Apollo / ZoomInfo / RocketReach), ranked multi-source later
  - Test: selecting Apollo runs only Apollo; switching to ZoomInfo runs only ZoomInfo.
- [x] Combine `policy`: **combine** (default — use all enabled sources) or **first** (stop at first confident hit)
  - Test: `first` stops once a confident value is found (later sources not called); `combine` runs all enabled sources.
- [x] LLM layer: add Gemini and Grok clients beside Anthropic/OpenAI behind `LLMClient`
  - Test: each provider returns a structured result from a mocked HTTP response.
- [x] Native web search path per provider (Anthropic `web_search`, Gemini `googleSearch`, OpenAI/Grok `web_search`)
  - Test: with web source `native`, the provider request includes its search tool; without it, it does not.
- [x] Web/scrape backends: `native` | `serper` (search) and `firecrawl` (scrape) selectable
  - Test: `serper`/`firecrawl` route through our existing tools.
- [x] BYOK + env key resolution per run (`keySource: env | byok`)
  - Test: a BYOK key is used for the run and never written to DB/logs; env key is used when `keySource=env`.
- [x] Execution: transform (no tools) vs research loop (tools), bounded by `maxSteps`
  - Test: a transform Dogi makes one call; a research Dogi loops and stops at the step ceiling.
- [x] Structured output + provenance written via existing `writeCell`
  - Test: a Dogi cell stores value + `{confidence, source, provider}`; the grid renders both.

## Phase D - Goal Mode (Dogi Plans + Builds Columns)

- [x] "Ask Dogi" entry point on a table (a goal text box)
  - Test: submitting a goal returns a structured plan, not prose.
- [x] Planner (LLM) emits a `dogi-plan`: ordered steps with `reads/output/sources` + `dependsOn`
  - Test: "find CEO email then write a custom email" yields 2 steps where step 2 depends on step 1's output column.
- [x] Plan review/approve UI: rename columns, switch output to map-existing, toggle search, change model, drop a step
  - Test: edits to the plan are reflected before anything is created.
- [x] On approve, create the columns from the plan (preview already shown), audited
  - Test: approving creates exactly the planned columns in the table.
- [x] Run steps in dependency order (a step runs only once its input columns are filled), reusing fan-out + run-only-if-empty
  - Test: step 2 cells fill only after step 1 cells are populated; re-running skips filled cells.
- [x] Partial-failure handling: a failed step surfaces per-row without blocking independent rows
  - Test: one row failing step 1 doesn't stop other rows from completing step 2.

## Phase E - Saved Agents, Cost, Test-5

- [x] `agents` table: save / name / reuse a Dogi or a whole goal-plan
  - Test: saving a Dogi then "use a saved agent" pre-fills its config on a new column.
- [x] Cost estimate before a run (pricing table + token counting, incl. web-search cost)
  - Test: estimated cost for N rows is shown before firing and is within a sane range of actuals.
- [x] Test 5 rows before a full-table run
  - Test: "Test" runs a 5-row sample; "Run all" only enabled after a test (configurable).
- [x] Pricing table covers all four providers + their web-search add-on
  - Test: each provider/model has input/output per-1M and search-per-1k entries.

## Phase F - Dogi Advanced (Visual Flow) — Stretch

- [ ] Flow data model (`config.flow`: nodes + edges) that compiles to the same plan
  - Test: a flow and an equivalent simple plan produce identical runs.
- [ ] Canvas UI + node palette: input · web search · scrape · LLM step · formula · branch · output(create/map)
  - Test: wiring nodes maps inputs→steps→outputs; invalid graphs are rejected with a clear message.
- [ ] Flow executor runs the graph (respecting branches and dependencies)
  - Test: an if/else branch routes to the right output; a multi-step flow fills its terminal column.

## Phase G - Optional Dedupe + Accounts Fold

- [x] Per-table dedupe policy: `none` (default) | `by columns` | `by company`
  - Test: importing the same people twice with `none` creates duplicates; with `by columns: [email]` it merges.
- [x] `ingestLead` takes an explicit policy; `findOrCreateAccount` becomes opt-in (only `by company`)
  - Test: with `none`, no accounts row is created; with `by company`, one row per domain.
- [x] Dedupe **existing** rows (Clay-style) from a column's `⋯` menu — not only at import
  - `dedupeExistingRows(tableId, keys, {dryRun?})`: group by trim+lowercase tuple, keep oldest, fill empties only (never clobber), delete dupes, audit; idempotent.
  - `GET /tables/:id/duplicates?keys=<csv>` (preview) + `POST /tables/:id/dedupe {keys}` (perform).
  - Frontend: "Dedupe rows by this column" → preview → confirm modal → result pill; import shows a hint, never a forced choice.
  - Test: 6 core db tests; verified live preview {1,1} → dedupe {merged:1,kept:1} → idempotent 0; keeper data preserved.
- [x] Remove Accounts from the headline nav (keep table/API for "companies as a table" later)
  - The sidebar no longer shows Accounts; the `/accounts` route + data are intact.

## Nav + Dogi pages (post-G UX)

- [x] Sidebar restructured: Workspace (Overview, Tables) · **Dogi (Agents, Settings)** · Outreach (Campaigns, Prompts, Reply inbox) · System (Jobs, Analytics); Reply-inbox icon `✉ → @`.
- [x] **Agents page** (`/agents`): list/delete saved Dogi/plan agents over `agentsApi`, kind pill + config summary + empty state.
- [x] **Settings page** (`/settings`): read-only key status via new `GET /settings` ({llm, keys:{…13 booleans}}, presence only — never values); grouped LLM/Enrichment/Tools/Send, default model, BYOK/.env note.

## Dogi live-verification + fix (Phase C follow-up)

- [x] Verified Dogi end-to-end against a real OpenAI key through API → pg-boss → worker → Postgres.
- [x] **Fix:** split the agent system prompt by execution shape — `SYSTEM_RESEARCH` (never-guess, for web/scrape/native) vs `SYSTEM_TRANSFORM` (produce a value, for LLM-only). The single research prompt had made every LLM-only column return `null`/failed. Documented in `devx/dogi-agent.md` §3/§12/§13.

## Phase G.2 - Grid/UX fixes + Dogi/Bone config & menu (from the 2026-06-06 review)

Surfaced by operating the live product; full reasoning in `devx/bone.md` + `devx/roadmap.md` §"Session findings".

### G.2a — New table is never a dead end (default blank row)
- [x] Creating a table seeds **one blank lead row** (so the grid shows row `1`, not "no rows yet").
  - Backend: `ensureDefaultTable`/table-create path inserts one empty lead for the new table; idempotent (don't double-seed).
  - Frontend: an empty table still renders one editable blank row + the index column shows `1`.
  - Decision (user): **no preset content columns** — only the structural checkbox + index columns. Just the blank row.
  - Test: POST a new table → `GET /tables/:id/leads` returns 1 row; the grid shows an editable row 1.

### G.2b — Visible loading state while an agent works
- [x] A cell in `queued`/`running` shows a **spinner/pulse** (not just a static dot); the machinery already exists (`/cell-jobs` polling, cell state machine).
- [x] A **header/toolbar indicator** ("Dogi working… N running") while any cell job for the table is in flight.
  - Keep it on existing tokens; no layout shift between states.
  - Test: run a Dogi column → cells visibly show running → resolve to filled; indicator appears then clears.

### G.2c — Agent activity log
- [x] Backend: `GET /tables/:id/activity` (and/or global `GET /activity`) over `audit_log` — action, entity, field, actor, timestamp, provenance; paginated, newest first.
- [x] Frontend: an **Activity** view (next to Jobs) listing what the agents did (columns created, cells filled, dedupe, plans) with provenance.
  - Reachable from the menu.
  - Test: run a column + a dedupe → both appear in `/activity` with correct action + timestamps.

### G.2d — Overview as a list (not cards)
- [x] Render the Overview tables as a **list** (rows: name, #rows, #cols, updated, ⋯ menu) instead of cards. Keep create-table + the per-row delete/rename menu. Consistent tokens.
  - Test: Overview shows tables as a list; create/delete still work.

### G.2e — Dogi & Bone are configurable and menu-accessible
- [x] Confirm the **Dogi config modal** persists & drives runs (already verified — keep a regression test).
- [x] **Bone settings** (its own + the default Dogi config it hands to columns it builds) are editable from a **Settings/Dogi** surface reachable in the menu.
  - Test: change Bone's default brain/provider → a new Bone run uses it.

## Phase I - Bone: autonomous orchestrator + row-sourcing

The headline gap: the planner only enriches existing rows; nothing **creates** rows. Bone fixes it. Design: `devx/bone.md`.

- [x] **Row-sourcing primitive** (backend): given a description + count, generate N entities and **insert N leads** into the table (with provenance + dedupe-aware so re-running doesn't duplicate).
  - Test: "top 10 companies" → 10 leads created; re-run doesn't double them.
- [x] **Bone planner** (promote the existing planner): decompose a goal into steps that are **row-sourcing** and/or **column** steps, ordered by `dependsOn`.
  - Test: "top 10 companies, their CEOs, CEO LinkedIn" → plan = [source 10 rows] → [col CEO] → [col LinkedIn].
- [x] **Plan-then-approve by default**, with a **"just do it" toggle** for autonomous execution.
  - `POST /tables/:id/bone/plan` (propose) + `POST /tables/:id/bone/run` (execute; `auto` flag skips approval).
  - Test: default returns a plan without mutating; `auto:true` creates rows+columns and runs.
- [x] **Execute**: create rows → create columns → run Dogis in dependency order (reuse the dependency-ordered worker). Each cell carries provenance; every action audited.
  - Test: end-to-end live "top N" goal fills a fresh table.
- [x] **Bone settings** persisted (table-scoped and/or global default), incl. the default Dogi config it spawns.
- [x] **Frontend — Ask Bone**: an entry on a table; shows the proposed plan; approve/edit; just-do-it toggle; progress while it runs; reachable from the menu.
  - Test: ask a goal → see plan → approve → table fills with rows + enriched columns.
- [~] Guardrails: cost estimate + a row/column ceiling + confirm before large autonomous runs; sourced rows respect the table's dedupe.

## Phase H - MCP (Project-Wide, Optional, Off Critical Path)

- [x] Fetch MCP server (read-only first): expose `tables`, `schema`, `rows`, `lead`, `jobs` resources
  - `apps/mcp` (@fetch/mcp), stdio, thin adapter over the REST API. Read tools: list_tables, get_table_schema, query_rows (+provenance), get_lead, get_job, recent_activity; also MCP resources (`fetch://tables`, `.../schema`, `.../rows`, `lead/{id}`). Live smoke: tools/list + list_tables returned real data.
- [x] MCP write tools: create_table/column, add_leads, run_column/run_cell, ask_bone/run_bone, dedupe
  - Run tools return job ids (async-native, poll `get_job`); `ask_bone` returns a plan, `run_bone` commits.
- [~] Cost/dry-run + gate: `estimate_cost` tool + dedupe `preview` shipped; `launch`/sending tools deferred (off critical path).
- [x] Auth + scoping: reuse `FETCH_API_TOKEN` (optional bearer); **read-only by default** (`FETCH_MCP_READONLY`, writes unregistered in read-only); audit via the API. Per-table scoped tokens deferred.
  - Test: read-only registry exposes only the 6 read tools; read-write adds the 10 writes; bearer set when token present (unit-tested).
- [ ] Fetch as MCP client: register an external MCP server; enable it per Dogi as an extra tool — *deferred (inbound direction).* 

## Phase J - Reliability round: Bone correctness, failure visibility, self-hosted search, Bone rename

From the 2026-06-06 review #2 (two real Bone runs gave partial results). Diagnosis in `devx/bone.md` + `devx/search-and-scrape.md`. Build in rounds; test + commit each; push per round after the user sees it work.

### Round 1 — Bone row-sourcing correctness (backend + frontend)
- [x] **Create a column for the sourced primary field.** A source-rows step must materialize a column for `primaryField` (e.g. "Company") so the sourced values are visible — not just written into `data`. (This is why "5 automobile companies + CEO + LinkedIn" made only 2 columns, not 3.)
  - Test: `/bone/run` on a "top N companies + …" plan creates a `company` column + the enrichment columns; the grid shows company names.
- [x] **Reuse the seeded blank row** instead of appending. When Bone sources N rows and the table has only the single default blank row, fill/replace it rather than ending up with N+1 and a guaranteed-failing empty row.
  - Test: new table (1 blank row) + source 5 → exactly 5 rows, none blank.
- [x] **Exact count.** Row-sourcing returns exactly the requested count (cap 50); if the model returns more/fewer, trim/pad-by-reprompt to hit the number (or report the shortfall).
  - Test: ask 10 → 10 rows (±0), not 11.
- [x] **Better entity quality.** Tighten the sourcing prompt so "AI companies" yields real companies (OpenAI, Anthropic, Nvidia…), not divisions/products ("Google AI", "Salesforce Einstein").
  - Test (judgment): a sourced list contains companies that have a single identifiable CEO.

### Round 2 — Failure visibility + re-run (the core UX gap)
- [x] **Per-cell status**, not per-lead. Record each cell's outcome (`filled` | `empty` | `failed`+reason) so a cell that ran-and-missed is distinct from never-run. Stop `enrichmentStatus` being a single last-writer-wins field.
  - Test: a lead with CEO filled + LinkedIn missed shows the CEO cell filled and the LinkedIn cell failed — not the whole row "failed".
- [x] **Failed-cell UI**: a red/amber marker + reason ("couldn't find") on cells that ran and failed; a **Re-run cell** and **Re-run row** action.
  - Test: a failed cell shows the marker; Re-run re-enqueues just that cell.
- [x] **Audit failures.** A Dogi miss writes an `audit_log` entry (action `enrich_failed`, with the field + reason) so it appears in `/activity` and isn't silently "completed" in `/jobs`.
  - Test: a missed cell appears in `/activity` with a failure action.
- [x] **Ask Bone result summary**: report rows created + per-column fill counts + how many cells failed, so the user sees the outcome, not just "queued".

### Round 3 — Self-hosted search & scrape (OpenSERP + Firecrawl). Design: `devx/search-and-scrape.md`
- [x] **`webSearch.ts`**: OpenSERP backend; precedence `OPENSERP_URL` → `SERPER_API_KEY` → unavailable. Normalized to the Serper shape.
- [x] **`scrapeUrl.ts`**: self-hosted Firecrawl via `FIRECRAWL_API_URL`; precedence `FIRECRAWL_API_URL` → `FIRECRAWL_API_KEY` → unavailable.
- [x] **`GET /settings`** backend: `search` block reports `openserp` / `serper` / `firecrawl_selfhosted` / `firecrawl` availability.
- [x] **Install + run the services**: OpenSERP (7001, yandex — google CAPTCHA-blocked on datacenter IPs) + self-hosted Firecrawl (3002) verified up; `docker-compose.search.yml` + `scripts/search.sh` + `devx/RUN-search-stack.md`.
- [x] **`.env.example`** + opt-in compose `search` profile; `scripts/dev.sh` baseline stays Postgres-only.
- [x] **Document** `devx/search-and-scrape.md` (as-built + pipeline chart + §10 "why it wasn't working").
- [x] **Tool-call replay fix** (the real blocker): `LLMMessage.toolCalls`, dogi.ts replays them, all 4 providers serialize the replay; `toolReplay.test.ts`. Verified live: "Hero MotoCorp" → CEO Harshavardhan Chitale + real moneycontrol.com source via OpenSERP+Firecrawl, no 400.
- [x] **R3 frontend gap:** Settings page shows OpenSERP/Firecrawl-selfhosted availability; `DogiConfigForm` gates the web/scrape toggles + a hint when the backend is down (consume `/settings.search`).

### Round 5 — Arbitrary columns (the data model is Clay-like, not fixed-schema)
A Fetch table is **arbitrary columns**; the legacy fixed identity fields (`first_name/last_name/email/phone/title/linkedin_url`) are a Part-I vestige. The quick-add path drops any non-schema field (e.g. `company`) and `leadContext` hardcodes identity — so a typed company is lost and Dogi has no anchor (the "Wes Schroll" bug). Fix:
- [x] **Quick-add stores arbitrary keys in `data`** (`POST /tables/:id/leads` / `manualLeadSchema`): any `{key:value}` becomes a column value; stop dropping non-schema fields. Still mirror recognized identity keys (email, name) to the canonical fields for send/dedupe.
  - Test: add a lead `{company:"Tata", outreach_angle:"x"}` → `data` has both; email still mirrors to canonical.
- [x] **`leadContext` surfaces the row's ACTUAL columns** (its real `data`), not a hardcoded identity list — Dogi always sees whatever the table holds.
  - Test: a Dogi with `reads:[]` still sees the row's `company`/other columns.
- [x] **Optional data-ready field templates** (frontend, completely optional): the add-column picker offers common presets — name / first_name / last_name / email / phone / title / linkedin_url / company — each with the right value type (email→email, linkedin→url…). Picking one is a convenience; columns remain fully arbitrary.
  - Test: choosing "Email" creates an `email`-typed column; a custom name still works.
- [x] Keep `email`/name canonical mirroring for sending/dedupe/validation (don't rip out the outreach pipeline).

### Audit (2026-06-06): job monitor + activity are functional
- [x] `/jobs` + `/jobs/summary` show real pg-boss status (grouped); `/activity` shows real `audit_log` (incl. `enrich_failed`). Confirmed functional — the only front/back gap is the R3 frontend item above.

### Round 4 — Rename the orchestrator → Bone (DONE)
- [x] Renamed the orchestrator agent to **Bone** across code identifiers, routes (`/tables/:id/bone/*`), persisted `table.settings.bone`, MCP tools (`ask_bone`/`run_bone`), UI ("Ask Bone 🐕"), and docs (`bone.md` + all references). **Dogi** (the cell agent) kept as-is.
  - Verified: full suite green; `POST /tables/:id/bone/plan` works and the old `/doggo/plan` 404s; stray-grep for the old name is zero.

## Ship Gate (Clay/Dogi direction)

- [ ] Create a table, add leads, and operate it like a spreadsheet (inline +column, edit any field, drag/resize/reorder, add row)
- [ ] Configure a Dogi (any of 4 providers, search on/off, BYOK or env) that fills a cell with provenance
- [ ] A Dogi output can create a new column or map to an existing one
- [ ] "Ask Dogi" plans a multi-column goal, you approve, and it builds + fills the columns in order
- [x] Save a Dogi/plan and reuse it; see a cost estimate; test 5 rows before a full run
- [x] Dedupe is the operator's choice per table; nothing is force-merged (import-time policy + dedupe-existing from the column menu)
- [ ] (Optional) An external AI client can drive Fetch over MCP within the gates

## Guardrails (Part II)

- Postgres is the single source of truth; the API enqueues, workers do slow work.
- Enrich in place; every Dogi cell carries value + confidence + source.
- Validation gates sending; approval gates sending; column creation is previewed/audited.
- No secrets in code or logs; BYOK keys never persisted; webhooks signed; public endpoints rate-limited.
- Two columns in a table never share a name; column value types are validated on edit.
- `pnpm typecheck && pnpm lint && pnpm test` stay green per phase.

## Phase B.1 - Fixes & Polish (grid, import mapping, example table)

- [x] Fix Next.js runtime error (`__webpack_modules__` / missing chunk): pin `outputFileTracingRoot` so a stray parent lockfile can't hijack the workspace root; clear stale `.next`.
  - Test: `pnpm dev:web` boots with no "inferred workspace root" warning; `/` and `/leads` render with no webpack error.
- [x] Import CSV → column-mapping step: after choosing a file, show its headers and let the user **map each header to an existing column or create a new one** (with a type), then import. A **blank table auto-creates** all headers as new columns.
  - Test: importing into a table with existing columns maps onto them; importing into a blank table creates the columns; values land in the right cells.
- [x] Grid spacing: cells and rows have breathing room (padding), not corner-to-corner.
  - Test: visual — cells have comfortable padding; the grid reads cleanly.
- [x] Seeded example **"Fetch table"**: a non-deletable example table whose **fixed columns are also non-deletable** (protection applies ONLY to this example table). Everything else (add rows/columns, run, edit) works normally.
  - Test: DELETE on the example table → 403; DELETE on a fixed column → 403; the UI hides those delete actions; a normal table/column deletes fine.


## Phase B.2 - Grid polish round 2 + row actions

- [x] Grid outer spacing (table not flush to sidebar/edges); revert loose cell padding.
- [x] "+ New lead" → "+ Add row"; blank row uses the table's own columns (no preassigned fields), appended at the end.
- [x] Overview: each table card has an always-visible ⋯ menu → delete (protected example table excepted).
- [x] Minimum column width + horizontal scroll past the viewport; first two (checkbox, row#) and last (+ add) columns pinned.
- [x] Pinned columns: fully OPAQUE background + a fixed divider border, and scrolling data columns clip BEHIND them (never bleed past/over the pinned columns).
  - Test: scroll horizontally — data cells disappear under the pinned columns; no see-through.
- [x] Dogi config panel: render as a proper modal (or fully scrollable) so the whole form is reachable header→bottom (incl. the lower sources like scrape). Currently it's cut off ~halfway.
  - Test: open a Dogi column config; every section (instruction → sources incl. scrape → policy → brain) is scrollable into view.
- [x] Column ⋯ menu: add **Edit name** and **Edit type** (value type / fill method), alongside run/duplicate/delete.
  - Test: rename a column and change its type from the ⋯ menu; both persist.
- [x] Row selection actions: when rows are checked, show a bulk-action bar — **Delete**, **Run** (run the table's runnable columns on the selected rows), Clear.
  - Test: select rows → Delete removes them; Run enqueues jobs only for the selected rows.
- [x] Backend: `DELETE /leads/:id`, bulk `POST /tables/:id/leads/delete { leadIds }`, and `POST /tables/:id/run { leadIds }` (run runnable columns on those rows).
  - Test: delete endpoints remove the rows; run enqueues per (selected lead × runnable column).

