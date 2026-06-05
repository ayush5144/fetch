# Fetch — Developer Documentation

> A working guide to the codebase: what each part is, how the pieces connect,
> and the rules the whole system bends around. For product scope see
> `dev_notes/PRD.md`; for the original design rationale see
> `dev_notes/ARCHITECTURE.md` and `dev_notes/WORKING.md`. This file documents
> the **code as built**.

---

## 1. The one idea

A lead enters Fetch once and becomes **one canonical record** in Postgres. Every
stage — ingest, enrich, validate, personalize, send, learn — is an *operation on
that same row*, never a handoff to another tool. The table the operator stares
at is always the live state of the lead.

Two rules make this hold:

1. **Postgres is the single source of truth.** State, the job queue, and event
   history all live in one database. Nothing to sync, nothing to drift.
2. **The API never does slow work.** It validates input, writes a row, and
   enqueues a job. **Workers** touch the network (LLMs, providers, SMTP) and
   write everything they learn back into the same rows.

---

## 2. Shape of the system

```
 Browser ──► apps/web (Next.js) ──REST──► apps/api (Hono)
                                              │  writes row + enqueues
                                              ▼
                            ┌──────────────────────────────┐
                            │  Postgres  (single source)    │
                            │  + pg-boss queue (same DB)     │◄── no Redis
                            └───────────────┬───────────────┘
                                            │ SKIP LOCKED dequeue
                                            ▼
                              apps/worker (pg-boss consumers)
                                            │ calls out
        ┌───────────────┬───────────────────┼────────────────────┐
        ▼               ▼                   ▼                    ▼
   enrichment        validation       personalization        senders
   (waterfall +      (syntax · MX ·   (prompt + guardrails)  (Instantly ·
    agent loop)       SMTP · …)                               Smartlead · SMTP)
```

Everything external (LLM, enrichment providers, send rails) sits behind a stable
interface, so any vendor swaps without touching the core.

---

## 3. Monorepo layout

A pnpm workspace. `apps/*` are runnable processes; `packages/*` are libraries
they share. Dependencies always point **inward** (apps → packages; packages →
`core`/`db`), never the reverse.

```
apps/
  api/      Hono server — routes/, middleware/. The front door.
  worker/   pg-boss consumers — handlers/, a shared runner wrapper.
  web/      Next.js App Router UI — app/ pages, components/, lib/.
packages/
  db/            Drizzle schema (the 10 tables) + pooled client + migrate.
  core/          env, logger, types, queue (pg-boss), dedupe/ingest, audit, jobs.
  connectors/    CSV + manual normalizers → CanonicalLead.
  columns/       dynamic column engine: cell I/O, formula, resolve, run fan-out.
  enrichment/    Provider interface + waterfall + provider impls.
  agent/         LLM tool-calling research loop + tools.
  llm/           provider-agnostic LLM client (Anthropic / OpenAI).
  validation/    email validation → status gate.
  personalization/ variable binding + guardrails + generation.
  senders/       SendAdapter interface + Instantly / Smartlead / SMTP.
infra/      docker-compose (Postgres + 3 services) + Dockerfiles.
scripts/    seed · backup · deploy.
```

---

## 4. The data model

Ten tables in `packages/db/src/schema`. The spine is **`leads`**; everything
above its `data` column is a **system column** (typed, the engine gates on it),
and everything inside `data` (JSONB, GIN-indexed) is a **user column**.

| Table | Role |
|---|---|
| `leads` | The canonical record — identity, enrichment/validation/personalization/send/event state, + `data` JSONB. |
| `accounts` | One company per `domain` (the dedupe key), shared across its leads. |
| `columns` | User-column **definitions** — `type` + `config` (how the cell fills). |
| `campaigns` | Outreach effort — provider, rules, template. |
| `sequences` | Ordered steps inside a campaign. |
| `jobs` | Observable projection of queue work for the Job Monitor. |
| `events` | Normalized provider outcomes; `provider_evt` is the idempotency key. |
| `prompts` | Versioned LLM templates + guardrails. |
| `sources` | Raw payload as received, per import. |
| `audit_log` | Append-only history of every change (the only place history lives). |

> **Enrich in place.** Values are written back into the `leads` row, never a
> parallel `enriched_leads` table. Need history? It's in `audit_log`.

---

## 5. How a request becomes work

The contract between the API and the worker is the **job**. `enqueue()` in
`packages/core/src/jobs.ts` does two things:

1. inserts a row into `jobs` (what the Job Monitor renders);
2. sends the payload to the pg-boss queue (what a worker claims).

The `jobs` row id rides along as `__jobRowId`, so the worker's shared `runner`
wrapper can flip the same row `active → completed | failed | dead` and record the
error. pg-boss owns retry/backoff/dead-letter; the `jobs` table just mirrors it
for humans.

```
API route ──enqueue(type, data)──► jobs row (queued) + pg-boss send
                                              │
worker boss.work(queue) ──claims──► runner.wrap() ──► handler(data)
                                              │ success / throw
                                  marks jobs row + pg-boss retry policy
```

Five queues, five handlers: **enrich · validate · personalize · send · event**.

---

## 6. The stages, in code

### Ingestion — `packages/connectors` + `core/dedupe.ts`
A `Normalizer` (CSV, manual) maps any source to a `CanonicalLead`. `ingestLead()`
finds-or-creates the account by domain, dedupes the lead by email (merge on
match, create otherwise), stores the raw payload in `sources`, and writes an
`audit_log` entry. Re-importing the same file merges — it never duplicates. A
no-email row imports fine (`validation_status = no_email`) without sinking the
batch.

### Dynamic columns — `packages/columns`
A column is *the definition of how a cell fills*. `planRun()` applies
**run-only-if-empty** and returns exactly the leads needing work; the API
enqueues one `enrich` job per row (enrichment/agent) or recomputes inline
(formula). `resolveCell()` dispatches by `column.type`:

- **enrichment** → provider waterfall, then the agent loop as fallback;
- **agent** → the LLM tool-loop driven by the column's prompt;
- **formula** → a safe, eval-free arithmetic/concat/coalesce evaluator;
- **manual** → never auto-run; a human types it.

`writeCell()` writes the value into `leads.data[key]` and its
`{ confidence, source }` into `leads.enrichmentConf[key]` with one `jsonb_set`.

### Enrichment — `packages/enrichment`
`Waterfall` queries providers **cheapest-first and stops on the first hit**
(you only pay for hits), with a per-(field, domain) cache for one run. Providers
implement `lookup(field, lead)` and declare `cost` + `available` (skipped when
their key is absent). A provider failure is a miss, not fatal.

### Agent — `packages/agent`
When the waterfall misses, `runAgent()` runs an LLM tool-calling loop
(`web_search` → `scrape_url` → reason) bounded by a **step ceiling**. It never
returns prose — only `{ value, confidence, source }`. Tools degrade gracefully
when their API key is absent.

### Validation — `packages/validation`
`validateEmail()` runs checks **cheapest-first** (syntax → disposable → MX →
SMTP via Reacher) and short-circuits. The returned status is a **hard gate**:
`isSendable()` allows only `valid` (opt-in `risky`).

### Personalization — `packages/personalization`
`buildVariables()` exposes lead + account + user-column values; `bindTemplate()`
fills `{{tokens}}`; the LLM returns `{ subject, body }`; `checkGuardrails()`
(length, required vars, banned claims) decides `ready` vs flagged `draft`. The
draft is written back to the lead row — a visible, editable artifact a human
approves before anything sends.

### Sending — `packages/senders`
The `SendAdapter` contract is two methods: `push(leads, campaign)` and
`parseEvent(payload)`. Each rail owns its own quirks (Instantly batches ≤1000 +
`skip_if_in_workspace`; Smartlead add-to-campaign; SMTP raw mail). Adding a rail
= one new adapter; nothing above it changes. The send handler gates to approved +
valid leads, records `provider_lead_id` + `send_status`, and writes a `sent`
event.

### Events — `apps/api/routes/webhooks.ts` + `worker/handlers/event.ts`
The webhook endpoint **verifies the signature, ACKs 200 immediately, and
enqueues an `event` job**. The handler normalizes the provider's event name to
the internal vocabulary, inserts the event **idempotently** (unique
`provider_evt`), matches the (often sparse) payload to the local lead by email /
provider id, and stamps the matching timestamp — closing the loop.

---

## 7. The web UI

A thin client over the API (`apps/web/lib/api.ts`). `useApi(path, pollMs)` makes
views live by polling — the no-extra-infra way to keep the table fresh. Surfaces:

| Route | Purpose |
|---|---|
| `/` | Overview — the funnel at a glance. |
| `/leads` | The table. Import, add column, run cell / run column, inline edit, filter. Each user cell shows value + confidence + provenance link. |
| `/accounts` | Company view. |
| `/campaigns` | Build, personalize, and launch (gated) campaigns. |
| `/prompts` | Versioned templates + guardrails. |
| `/inbox` | Replies and bounces folded back from events. |
| `/jobs` | Job Monitor — status, attempts, errors, retry. |
| `/analytics` | Engagement funnel from the events table. |

**Design language:** a near-white canvas, deep navy ink (`--ink`), and a single
warm coral accent (`--accent`) used only for primary actions and emphasis.
Hairline borders, generous whitespace, calm status pills. All tokens live at the
top of `apps/web/app/globals.css`; change the palette there and it cascades.

---

## 8. Locked decisions (and where they live)

| Decision | Enforced in |
|---|---|
| Postgres is the single source of truth | `packages/db` — one schema, one pool |
| API never does slow work | `apps/api` enqueues; `apps/worker` executes |
| Waterfall + agent; stop-on-first-hit; run-only-if-empty | `enrichment/waterfall.ts`, `columns/engine.ts` |
| Confidence + provenance on every cell | `columns/cell.ts` (`writeCell`) |
| Validation gates sending | `validation/index.ts` (`isSendable`), `campaigns` launch |
| Personalization is a stored, approvable artifact | `worker/handlers/personalize.ts` |
| Sending is behind an adapter | `senders/adapter.ts` + `getAdapter()` |
| Events normalized + idempotent | `worker/handlers/event.ts`, `events.provider_evt` unique |
| No Redis in the baseline | `core/queue` — pg-boss inside Postgres |
| Enrich in place; history in `audit_log` | `columns/cell.ts`, `core/audit.ts` |

---

## 9. Configuration

All config flows through `packages/core/src/env.ts`, which validates with Zod and
**fails fast** on a bad/missing required var. Only `DATABASE_URL` is required to
boot; every other key unlocks a capability (`isConfigured()` reports which).
Secrets come from env only — never code or logs. See `.env.example`.

---

## 10. Running, building, extending

```bash
pnpm install
pnpm db:migrate         # idempotent
pnpm seed               # demo data
pnpm dev:api            # :4000
pnpm dev:worker
pnpm dev:web            # :3000
pnpm typecheck          # all workspaces
pnpm build
```

**Add an enrichment provider:** implement `ConfigurableProvider` in
`packages/enrichment/src/providers`, register it in `Waterfall`'s default list.
**Add a send rail:** implement `SendAdapter`, wire it into `getAdapter()`.
**Add a column type:** extend `resolveCell()` and the `AddColumnModal` form.
Nothing above these seams needs to change — that's the whole point.
