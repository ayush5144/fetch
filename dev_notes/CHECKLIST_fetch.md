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

- [ ] "Ask Dogi" entry point on a table (a goal text box)
  - Test: submitting a goal returns a structured plan, not prose.
- [ ] Planner (LLM) emits a `dogi-plan`: ordered steps with `reads/output/sources` + `dependsOn`
  - Test: "find CEO email then write a custom email" yields 2 steps where step 2 depends on step 1's output column.
- [ ] Plan review/approve UI: rename columns, switch output to map-existing, toggle search, change model, drop a step
  - Test: edits to the plan are reflected before anything is created.
- [ ] On approve, create the columns from the plan (preview already shown), audited
  - Test: approving creates exactly the planned columns in the table.
- [ ] Run steps in dependency order (a step runs only once its input columns are filled), reusing fan-out + run-only-if-empty
  - Test: step 2 cells fill only after step 1 cells are populated; re-running skips filled cells.
- [ ] Partial-failure handling: a failed step surfaces per-row without blocking independent rows
  - Test: one row failing step 1 doesn't stop other rows from completing step 2.

## Phase E - Saved Agents, Cost, Test-5

- [ ] `agents` table: save / name / reuse a Dogi or a whole goal-plan
  - Test: saving a Dogi then "use a saved agent" pre-fills its config on a new column.
- [ ] Cost estimate before a run (pricing table + token counting, incl. web-search cost)
  - Test: estimated cost for N rows is shown before firing and is within a sane range of actuals.
- [ ] Test 5 rows before a full-table run
  - Test: "Test" runs a 5-row sample; "Run all" only enabled after a test (configurable).
- [ ] Pricing table covers all four providers + their web-search add-on
  - Test: each provider/model has input/output per-1M and search-per-1k entries.

## Phase F - Dogi Advanced (Visual Flow) — Stretch

- [ ] Flow data model (`config.flow`: nodes + edges) that compiles to the same plan
  - Test: a flow and an equivalent simple plan produce identical runs.
- [ ] Canvas UI + node palette: input · web search · scrape · LLM step · formula · branch · output(create/map)
  - Test: wiring nodes maps inputs→steps→outputs; invalid graphs are rejected with a clear message.
- [ ] Flow executor runs the graph (respecting branches and dependencies)
  - Test: an if/else branch routes to the right output; a multi-step flow fills its terminal column.

## Phase G - Optional Dedupe + Accounts Fold

- [ ] Per-table dedupe policy: `none` (default) | `by columns` | `by company`
  - Test: importing the same people twice with `none` creates duplicates; with `by columns: [email]` it merges.
- [ ] `ingestLead` takes an explicit policy; `findOrCreateAccount` becomes opt-in (only `by company`)
  - Test: with `none`, no accounts row is created; with `by company`, one row per domain.
- [ ] Remove Accounts from the headline nav (keep table/API for "companies as a table" later)
  - Test: the sidebar no longer shows Accounts; existing account data is intact.

## Phase H - MCP (Project-Wide, Optional, Off Critical Path)

- [ ] Fetch MCP server (read-only first): expose `tables`, `schema`, `rows`, `lead`, `jobs` resources
  - Test: a local MCP client lists tables and reads a lead's record with provenance.
- [ ] MCP write tools: create_table/column, add_leads, run_column/run_cell, ask_dogi
  - Test: run tools return a job id; the client polls `jobs/{id}` to completion (async-native).
- [ ] Cost/dry-run + gate: `estimate_cost`, a `dryRun` flag, and `launch` honoring validation+approval
  - Test: a non-eligible lead is never sent via MCP; a dry-run reports cost without firing.
- [ ] Auth + scoping: reuse `FETCH_API_TOKEN`; read-only vs read-write; per-table scope; audit every action
  - Test: a read-only token cannot mutate; a scoped token cannot touch another table; actions appear in `audit_log`.
- [ ] Fetch as MCP client: register an external MCP server; enable it per Dogi as an extra tool
  - Test: a Dogi with an enabled MCP tool can call it; disabled Dogis cannot; calls are audited.

## Ship Gate (Clay/Dogi direction)

- [ ] Create a table, add leads, and operate it like a spreadsheet (inline +column, edit any field, drag/resize/reorder, add row)
- [ ] Configure a Dogi (any of 4 providers, search on/off, BYOK or env) that fills a cell with provenance
- [ ] A Dogi output can create a new column or map to an existing one
- [ ] "Ask Dogi" plans a multi-column goal, you approve, and it builds + fills the columns in order
- [ ] Save a Dogi/plan and reuse it; see a cost estimate; test 5 rows before a full run
- [ ] Dedupe is the operator's choice per table; nothing is force-merged
- [ ] (Optional) An external AI client can drive Fetch over MCP within the gates

## Guardrails (Part II)

- Postgres is the single source of truth; the API enqueues, workers do slow work.
- Enrich in place; every Dogi cell carries value + confidence + source.
- Validation gates sending; approval gates sending; column creation is previewed/audited.
- No secrets in code or logs; BYOK keys never persisted; webhooks signed; public endpoints rate-limited.
- Two columns in a table never share a name; column value types are validated on edit.
- `pnpm typecheck && pnpm lint && pnpm test` stay green per phase.
