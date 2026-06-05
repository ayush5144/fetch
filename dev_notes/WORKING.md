# Fetch — Working & System Flow
*Version 1.0 — June 2026*

This document explains **how Fetch runs** — what each block does, the logic it follows,
and the reason it exists. For the structural layers, objects, and full schema see
`ARCHITECTURE.md`; for scope and requirements see `PRD.md`. No code here — only the flows,
the reasoning, and the stack.

---

## Stack Map — What Runs, What It Does, Why

```
┌──────────────────────────────────────────────────────────────────────────┐
│  COMPONENT            ROLE                          COST NATURE            │
├──────────────────────────────────────────────────────────────────────────┤
│  Postgres 18          Single source of truth        your VPS / managed     │
│                       (leads, jobs, events, columns)                       │
│  pg-boss              Job queue, lives IN Postgres   included (no Redis)    │
│  API (TypeScript)     Front door; enqueues jobs      your VPS              │
│  Worker pool (TS)     Runs the slow work             your VPS              │
│  Next.js (App Router) Table-first operator UI        your VPS / Vercel      │
│  LLM (Claude / GPT)   Reasoning, extraction, copy    usage-based ($/token) │
│  Enrich providers     Apollo, Hunter, Findymail …    per-hit credits       │
│  Agent tools          Serper/Brave, Firecrawl,       usage-based           │
│                       Playwright (gated pages)                             │
│  Validation           Reacher + MX + SMTP checks     usage-based / self-run │
│  Send adapters        Instantly, Smartlead, SMTP     provider plan         │
│  Drizzle ORM          Type-safe Postgres access      free                  │
│  Docker Compose       One-command self-host          free                  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why this shape:**
- **Postgres is the only stateful thing that matters.** State, the job queue, and event
  history all live in one database, so there is nothing to keep in sync and nothing to drift.
- **pg-boss instead of Redis/Celery** keeps the baseline deploy to *one database + the app* —
  the bar for "self-hostable open source" in practice.
- **Everything external is usage-based and behind an interface** (LLM, enrichment, sending),
  so cost scales with use and any vendor can be swapped without touching the core.

---

## Full System — Every Component Connected

```
            OPERATOR (browser)                INBOUND WEBHOOKS
                  │                          (Instantly / Smartlead)
                  ▼                                   │
        ┌───────────────────────┐                     │
        │   Next.js UI          │                     │
        │   lead table · runs · │                     │
        │   approvals · monitor │                     │
        └───────────┬───────────┘                     │
                    │ REST / RPC                       │
                    ▼                                  ▼
        ┌────────────────────────────────────────────────────────┐
        │   API LAYER (TypeScript)                                │
        │   • writes a row   • enqueues a job   • takes webhooks   │
        │   NEVER does slow / network work itself                 │
        └───────────┬──────────────────────────────┬─────────────┘
                    │ write + enqueue               │ event job
                    ▼                               ▼
        ┌───────────────────────┐        ┌───────────────────────┐
        │   POSTGRES            │◄──────► │   pg-boss QUEUE        │
        │   single source of    │  same   │   (rows in Postgres)   │
        │   truth               │   DB    │   FOR UPDATE SKIP      │
        │   leads · accounts    │         │   LOCKED dequeue       │
        │   columns · jobs      │         └───────────┬───────────┘
        │   events · campaigns  │                     │ claims job
        │   prompts · audit_log │                     ▼
        └───────────┬───────────┘        ┌───────────────────────┐
                    │  workers read &     │   WORKER POOL          │
                    └──── write the ──────│   enrich · validate ·  │
                         same rows        │   personalize · send · │
                                          │   event                │
                                          └───────────┬───────────┘
                                                      │ calls out
            ┌──────────────┬───────────────┬──────────┴───────────┐
            ▼              ▼               ▼                       ▼
      ┌───────────┐ ┌─────────────┐ ┌─────────────┐      ┌─────────────────┐
      │ LLM LAYER │ │ ENRICH      │ │ VALIDATION  │      │ SEND ADAPTERS   │
      │ Claude/GPT│ │ PROVIDERS   │ │ Reacher/MX  │      │ Instantly       │
      │ tool loop │ │ (waterfall) │ │ /SMTP       │      │ Smartlead/SMTP  │
      └───────────┘ └─────────────┘ └─────────────┘      └────────┬────────┘
                                                                  │ sends mail
                                                                  ▼
                                                         events return via the
                                                         webhook path (top right)
                                                         → API → events table
```

**The core loop, in points:**
- **The API is fast and dumb on purpose.** It validates input, writes a row, and drops a
  job. It never waits on an LLM or a provider, so the UI is always responsive.
- **Workers are where the world is touched.** Every slow or failable thing — LLM calls,
  provider lookups, SMTP, sending — happens in a worker that can retry.
- **Everything a worker learns is written back into the same Postgres rows** the UI is
  already rendering. There is no second copy of the lead anywhere.
- **The loop closes** when provider events come back through the webhook path and update
  the very same row that was sent. That return arrow is what makes Fetch an OS, not a pipeline.

---

## Flow 1 — Lead Ingestion

```
CSV / API / webhook / manual entry
          │
          ▼
┌─────────────────────────────────────────────┐
│  API LAYER                                   │
│  • Normalizer maps the source → one schema   │
│  • Dedupe: match on email (lead) + domain    │
│    (account)                                 │
│  • match → merge/update   no match → create  │
│  • store raw payload in `sources`            │
│  • write audit_log entry                     │
└──────────────────┬───────────────────────────┘
                   ▼
        Canonical Lead Row in Postgres
                   │
                   ▼
        Enqueue jobs based on WHAT'S MISSING
        (enrich? validate? both? neither?)
```

- **What it does:** turns any incoming shape into one canonical lead and decides what work it needs.
- **Logic:** dedupe first so re-imports never duplicate; the *gap* in the data — not a fixed order — decides which jobs get created.
- **Reason:** if every source produces an identical record, every later stage can be written once and work everywhere. Storing the raw payload means a bad mapping can be reprocessed without re-importing.

---

## Flow 2 — Run a Column: Enrichment (Waterfall + Agent)

This is the centerpiece. A column is a *definition of how a cell fills*; running it fans
one job out per row.

```
Operator runs column "company_size" over a filter
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│  ENRICHMENT JOB (one per row)                            │
│                                                          │
│  Step 1: run-only-if-empty                               │
│          cell already has a value? → SKIP (no cost)      │
│                                                          │
│  Step 2: WATERFALL (cheapest provider first)             │
│          Provider A → hit? ─ yes → STOP                  │
│             │ no                                         │
│          Provider B → hit? ─ yes → STOP                  │
│             │ no                                         │
│          Provider C → hit? ─ yes → STOP                  │
│             │ no (structured sources exhausted)          │
│             ▼                                            │
│  Step 3: AGENT LOOP (fallback)                           │
│          LLM + tools, looping until found or step-limit: │
│            web_search()   → Serper / Brave               │
│            scrape_url()   → Firecrawl                    │
│            extract_field()→ Firecrawl extract            │
│            browser_action()→ Playwright (gated only)     │
│                                                          │
│  Step 4: structured output { value, confidence, source } │
│          merge into leads.data only if empty/higher-conf │
│                                                          │
│  Step 5: write cell + provenance; set enrichment_status  │
└──────────────────────────────────────────────────────────┘
          │
          ▼
   Cell renders live in the table with a source link
```

- **What it does:** fills one user-defined cell with the cheapest source that can answer it.
- **Logic — three guards:** *run-only-if-empty* avoids re-paying; *stop-on-first-hit* halts the waterfall the instant a value is found; the *agent loop* only runs when structured providers all miss.
- **Reason — cost and trust:** structured APIs cost cents and answer most fields; the LLM is powerful but expensive, so it's the last resort. Every value carries confidence + a source URL so the operator can click into where a number came from instead of taking it on faith.

| Cost guard | What it saves |
|---|---|
| Run-only-if-empty | Skips already-filled cells on re-runs |
| Stop-on-first-hit | Never queries provider B/C once A answers |
| Agent as fallback only | Avoids LLM spend when a cheap API would do |
| Per-(field, domain) cache | One company looked up once per run, not per lead |
| Step + cost ceiling | Caps a runaway agent loop, returns partial result |

---

## Flow 3 — Validation

```
Lead with email
   │
   ▼ syntax ok? ── no ──► invalid
   │ yes
   ▼ MX records? ── no ──► invalid
   │ yes
   ▼ mailbox reachable? (Reacher SMTP) ── no ──► risky / bounced
   │ yes
   ▼ disposable domain? ── yes ──► disposable
   │ no
   ▼ catch-all / duplicate checks
   │
   ▼
 status: valid · risky · invalid · disposable · duplicate · no_email
   │
   ▼
 GATE: only `valid` (opt-in `risky`) is campaign-eligible
```

- **What it does:** decides whether a lead is safe to email and sets a status the rest of the system obeys.
- **Logic:** checks run cheapest-first (syntax before an SMTP probe), and the status is a hard gate on eligibility, not advisory.
- **Reason:** outreach tools are only as good as the list feeding them. The gate is what stops Fetch from becoming a send-anything machine that burns sending domains.

---

## Flow 4 — Personalization

```
Validated lead + campaign template
   │
   ▼ Prompt Builder
     binds {{variables}} from lead + account + data + signals
   │
   ▼ LLM draft → { subject, opener, body, cta }
   │
   ▼ Guardrails
     length · required vars present · banned claims · tone
     fail → flag for review     pass → write to lead row
   │
   ▼ state: draft → ready
   │
   ▼ Human preview / approve → approved
```

- **What it does:** turns a template + the lead's enriched context into a per-lead message.
- **Logic:** generation is just another agent column; the draft is written *back to the row* and must clear guardrails before it can be approved.
- **Reason:** personalization as a visible, editable data artifact (not an invisible AI step) means a human can read, fix, and approve before anything sends — quality stays under human control.

---

## Flow 5 — Sending via Instantly

```
Approved + valid leads, attached to a campaign
   │
   ▼ SEND JOB
   │
   ▼ ADAPTER LAYER (selects provider for this campaign)
   │   Instantly adapter:
   │     • map lead → payload (custom_variables)
   │     • batch in chunks of ≤1000
   │     • skip_if_in_workspace, verify_on_import
   │   Smartlead adapter / SMTP adapter: same interface
   │
   ▼ provider accepts
   │
   ▼ store provider_lead_id + send_status = sent
```

- **What it does:** translates Fetch's canonical lead into exactly what the chosen provider expects, and records that it left.
- **Logic:** only approved + valid leads are eligible; the adapter owns all vendor-specific quirks (batch size, flags, payload shape) so the core stays vendor-neutral.
- **Reason:** because sending is behind a stable `push()` interface, you can start on Instantly and add Smartlead later with zero changes above the adapter — the rails are interchangeable.

---

## Flow 6 — Event Feedback

```
Instantly / Smartlead  ──webhook──►  API: POST /webhooks/{provider}
   │
   ▼ verify signature  (reject if forged)
   │
   ▼ idempotency check  (unique provider_evt → dedupe redeliveries)
   │
   ▼ ACK 200 immediately, then process via an `event` job
   │
   ▼ normalize names → sent · opened · clicked · replied · bounced · unsubscribed
   │
   ▼ match to local lead by email / provider_lead_id
   │
   ▼ insert events row  +  update lead timestamps  +  update campaign metrics
   │
   ▼ table + analytics go live
```

- **What it does:** receives outcomes from the provider and folds them back into the same lead row.
- **Logic:** acknowledge fast then work async (providers retry only a few times and time out quickly); dedupe by the provider's event id so a redelivered webhook never double-counts.
- **Reason:** Fetch is already the lead store, so even a *sparse* payload (Smartlead sends little more than an email + campaign id) resolves to full local context. This return path is the difference between a learning system and a one-way pipeline.

---

## Job Lifecycle & Orchestration

```
   enqueue
      │
      ▼
  ┌────────┐   worker claims    ┌────────┐   success   ┌───────────┐
  │ queued │ ─────────────────► │ active │ ──────────► │ completed │
  └────────┘  FOR UPDATE        └────────┘             └───────────┘
                SKIP LOCKED          │ throws
                                     ▼
                               ┌──────────┐  retries exhausted  ┌────────────┐
                               │  failed  │ ──────────────────► │ dead-letter│
                               │ (retry,  │                     │ (inspect / │
                               │  backoff)│                     │  replay)   │
                               └──────────┘                     └────────────┘
```

- **What it does:** every slow operation is a row-backed job a worker drains.
- **Logic:** `FOR UPDATE SKIP LOCKED` lets many workers pull from one queue without ever grabbing the same job; failures retry with backoff, then dead-letter; handlers are idempotent so a re-run is safe.
- **Reason:** if one provider times out, that single job fails — the lead row still exists, the rest of the table is untouched, and the operator retries just that cell. Failure is contained to a job, never the dataset. Keeping the queue *in Postgres* is what removes Redis from the deploy.

| Trigger | Scope of jobs created |
|---|---|
| Operator clicks one cell | 1 job, 1 lead |
| Operator selects a filter | a batch of jobs |
| Operator runs the whole table | jobs fan out across the dataset |
| Inbound webhook | 1 event job |

---

## The Dynamic Column Engine — How a Cell Fills

```
column definition (key, type, config)        leads.data (per-row JSONB)
        │                                              ▲
        │ "Run column"                                 │ write { value, confidence, source }
        ▼                                              │
   one job per row ──► resolves by TYPE: ──────────────┘
        enrichment → provider waterfall (Flow 2)
        agent      → LLM tool loop (Flow 2 fallback)
        formula    → derive from other columns (recompute on change)
        manual     → human types it (no job)
```

- **What it does:** lets an operator add any column and choose *how* it fills, Clay-style.
- **Logic:** system columns (email, statuses) stay fixed and gate behavior; everything else is a user column living in one JSONB field, GIN-indexed for filtering. A column is a *reusable job definition*, so running it = firing that job across rows.
- **Reason:** the product feels like a spreadsheet you can extend, but underneath each column is a typed, observable operation — not a fragile formula glued to an external tool.

---

## Why These Choices

| Decision | Reason |
|---|---|
| Postgres as single source of truth | One place for state, jobs, and events → nothing drifts or needs syncing. |
| Queue inside Postgres (pg-boss) | No Redis → the self-host baseline is one DB + the app. |
| API enqueues, workers execute | UI stays fast; slow/failable work is isolated and retryable. |
| Enrich in place (no `enriched_leads`) | A parallel table is a sync bug waiting to happen; history goes to `audit_log`. |
| Waterfall before agent | Cheap structured data first; expensive LLM only when needed. |
| Confidence + provenance on every cell | Operators trust data they can trace to a source. |
| Adapter pattern for sending | Rails are interchangeable; the core never learns a vendor's shape. |
| Provider-agnostic LLM layer | Not locked to one model; swap Claude/GPT behind one interface. |
| Normalize events on intake | One internal vocabulary; idempotent by provider event id. |

---

## Data Movement Summary

| Stage | Input | Process | Writes back to |
|---|---|---|---|
| Ingest | CSV / API / webhook / CRM | normalize + dedupe | `leads`, `sources`, `audit_log` |
| Enrich | lead row + column def | waterfall → agent loop | `leads.data` (+ confidence/source) |
| Validate | email / domain | syntax · MX · SMTP · disposable | `leads.validation_status` |
| Personalize | lead + template | LLM draft + guardrails | `leads` (subject/body, approval) |
| Send | approved + valid lead | adapter → provider API | `leads` (provider_id, send_status) |
| Track | provider webhook | normalize + dedupe | `events`, `leads` timestamps, campaign metrics |

The whole system is this one table read top to bottom: a single record moving through six
operations, every one of them writing back to the same place.

---

*Document 3 of 3 — Working*
*See also: PRD.md / ARCHITECTURE.md*
