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

- [ ] Build the lead table: filter, sort, inline edit, run-cell, run-column
  - Test: an operator triggers enrichment per row, per filter, and for the whole table.
- [ ] Show value, confidence, and source link per cell
  - Test: a cell tooltip/expander shows confidence and a working source link.
- [ ] Build the account view with company context and linked leads
  - Test: an account page lists every lead attached to its domain.
- [ ] Build the campaign builder: template, rules, provider selection
  - Test: launching a campaign enqueues sends only for eligible leads.
- [ ] Build the prompt editor with versions and guardrails
  - Test: editing a prompt creates a new version without overwriting approved copy.
- [ ] Build the job monitor view
  - Test: job status, errors, retries, and dead-letter reflect real worker state.
- [ ] Build the reply inbox from events
  - Test: replies, bounces, and unsubscribes appear as they arrive.
- [ ] Build analytics: deliverability, engagement, conversion per campaign
  - Test: analytics numbers match the events table.
- [ ] Make the table live without manual refresh
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

- [ ] Write self-host docs with a one-command bring-up
  - Test: a fresh machine reaches a working instance from the README alone.
- [ ] Add a production env template
  - Test: required env names match the app code exactly.
- [ ] Add a deploy script: pull, install, build, migrate, restart
  - Test: the deploy script exits 0 on a clean host.
- [ ] Add a daily `pg_dump` backup script and a tested restore
  - Test: backup → wipe → restore recovers all leads and events intact.
- [ ] Add uptime and error monitoring
  - Test: the monitor alerts on downtime and a test error appears in tracking.

## Ship Gate (MVP)

- [ ] CSV → canonical lead with no duplicates
- [ ] User can add a column and run it across rows
- [ ] Enrichment fills cells with confidence + source (waterfall + agent)
- [ ] Validation gates sending
- [ ] Personalized copy is previewable and approvable
- [ ] Approved leads send via Instantly
- [ ] Replies/opens/bounces flow back into the same rows
- [ ] The whole loop is operable from the UI
- [ ] A second provider (Smartlead) works with no core changes
- [ ] A stranger can self-host from the README
