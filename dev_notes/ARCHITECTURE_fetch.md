# Fetch — Architecture

*Open-source GTM OS — June 2026*

---

## What Fetch Is

Fetch is a **self-hostable, open-source GTM operating system**. One lead enters the
system, and Fetch owns its entire life: ingest → enrich → validate → personalize →
send → learn. Every stage is an operation on the **same lead record**, not a handoff
between disconnected tools.

The mental model people already know is **Clay** — waterfall enrichment, AI research,
a table you operate from. Fetch takes that model and extends it *downstream* into
sending and *upstream* into a real data model. **Instantly and Smartlead are delivery
rails**, plugged in through an adapter layer. They are integrations, not the product.

The one rule everything bends around: **Postgres is the single source of truth.** Every
layer reads from it and writes back to it, so the table the operator stares at is always
the live state of the lead.

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          OPERATOR'S BROWSER                            │
│              (lead tables · campaign builder · job monitor)            │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          WEB UI  (Next.js)                             │
│   Lead table · Account view · Campaign builder · Prompt editor         │
│   Job monitor · Reply inbox · Analytics                                │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │  REST / RPC
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          API LAYER  (server)                           │
│   Auth · CRUD · validation of input · ENQUEUES jobs                    │
│   POST /leads/import   POST /jobs   POST /campaigns   POST /send        │
│   POST /webhooks/instantly   POST /webhooks/smartlead                   │
└───────────┬───────────────────────────────────────────┬────────────────┘
            │ writes rows + enqueues                     │ inbound events
            ▼                                            ▼
┌────────────────────────────┐              ┌───────────────────────────┐
│        POSTGRES             │◄────────────►│      JOB QUEUE             │
│  (single source of truth)  │   read/write │   (pg-boss, in Postgres)   │
│                            │              │   SELECT … FOR UPDATE      │
│  leads · accounts          │              │   SKIP LOCKED              │
│  campaigns · sequences     │              └─────────────┬─────────────┘
│  jobs · events · prompts   │                            │ claims job
│  sources · audit_log       │                            ▼
└────────────┬───────────────┘              ┌───────────────────────────┐
             │                              │      WORKER POOL           │
             │  every worker reads &        │  enrichment · validation   │
             └─────── writes the same ──────│  personalization · send    │
                      lead rows             └─────────────┬─────────────┘
                                                          │ calls out
                  ┌───────────────────────────────────────┼───────────────────┐
                  ▼                    ▼                    ▼                   ▼
        ┌─────────────────┐ ┌──────────────────┐ ┌────────────────┐ ┌────────────────┐
        │   LLM LAYER     │ │  ENRICH PROVIDERS │ │  VALIDATION    │ │  SEND ADAPTERS │
        │ Claude / GPT    │ │  Apollo · Hunter  │ │  ZeroBounce    │ │  Instantly     │
        │ tool-calling    │ │  Findymail ·      │ │  MX / SMTP     │ │  Smartlead     │
        │ research loop   │ │  Dropcontact …    │ │  disposable    │ │  SMTP/webhook  │
        └─────────────────┘ └──────────────────┘ └────────────────┘ └───────┬────────┘
                                                                            │ events
                                                                            ▼
                                                            (webhooks flow back to API,
                                                             then into Postgres events)
```

The shape to notice: the **API never does slow work**. It writes a row and drops a job.
**Workers** do everything that touches the network — LLMs, enrichment providers,
validation, sending. Everything they learn is written back into the same Postgres rows
the UI is already rendering.

---

## Layer Responsibilities

| Layer | What it does | Why it exists |
|---|---|---|
| **Web UI** | Table-first workspace to review, edit, approve, and launch. | So a human can operate the whole motion in one place. |
| **API layer** | Auth, CRUD, input validation, job enqueue, webhook intake. | So the system has one front door and stays fast. |
| **Data layer (Postgres)** | Stores every canonical record. | So state is never spread across tools or spreadsheets. |
| **Job queue** | Holds and dispatches background work. | So slow operations never block the UI or each other. |
| **Worker pool** | Executes enrichment, validation, personalization, send. | So work is async, retryable, and observable. |
| **LLM layer** | Reasoning, field extraction, copy generation. | So enrichment and personalization are AI-native. |
| **Enrichment providers** | External data sources queried in a waterfall. | So coverage is high without paying for every source. |
| **Validation layer** | Email + lead quality checks. | So Fetch never becomes a send-anything machine. |
| **Send adapters** | Translate Fetch leads into Instantly/Smartlead. | So delivery is swappable, not hard-wired. |
| **Event intake** | Receives provider webhooks, normalizes them. | So outcomes flow back and the system learns. |

---

## Core Domain Objects

Everything in Fetch is one of nine objects. If a workflow stage can't be expressed as an
operation on one of these, it doesn't belong in the core.

| Object | Meaning |
|---|---|
| **Lead** | One person who may be contacted. The spine of the system. |
| **Account** | The company a lead belongs to. Enriched once, shared across leads. |
| **Campaign** | A structured outreach effort — template, targeting, rules. |
| **Sequence** | The ordered steps and timing inside a campaign. |
| **Job** | A unit of background work (enrich / validate / personalize / send). |
| **Event** | A tracked outcome — sent, open, click, reply, bounce, unsubscribe. |
| **Prompt** | A versioned template that instructs the LLM. |
| **Source** | Where a lead came from + the raw payload it arrived as. |
| **Audit log** | An append-only history of what changed, when, and by whom. |

---

## The Canonical Lead — the spine

Every source — CSV, webhook, CRM, manual entry — is normalized into **one lead schema**.
A lead is not a flat row of contact fields; it carries the *state of every stage* it has
been through. That is what makes the table feel like Clay on the surface and behave like
an operating system underneath.

| Field group | Holds | Written by |
|---|---|---|
| **Identity** | first/last name, email, phone, title, LinkedIn | ingestion + enrichment |
| **Company** | company name, domain, industry, size, tech stack | enrichment (account-level) |
| **Source** | source type, raw payload, source URLs | ingestion |
| **Enrichment state** | status, last job id, **confidence**, **provenance URLs** | enrichment worker |
| **Validation state** | email status, MX/SMTP result, disposable, duplicate flag | validation worker |
| **Personalization** | subject, body, prompt version, approval state | personalization worker + human |
| **Sending state** | campaign id, provider, send status, sent_at | send worker |
| **Event state** | opened_at, clicked_at, replied_at, bounced_at, unsubscribed_at | event intake |

Two fields do a lot of quiet work: **confidence** and **provenance**. When the agent
fills "company size = 240," it also records *how sure it is* and *which URL it read*. The
operator can trust a cell because they can click into where it came from.

---

## Dynamic Columns — the Clay part

The fields above are **system columns**: fixed, typed, and reasoned about by the engine
(validation gates on `email`, sending gates on `validation_status`, etc.). But the
defining feature of a Clay-style product is that **the operator can add any column they
want** — `company_size`, `recent_funding`, `uses_shopify`, `ceo_name`,
`personalized_opener` — and Fetch fills it.

So Fetch uses a **hybrid model**:

| Column kind | Defined by | Stored in | Reasoned about by engine? |
|---|---|---|---|
| **System columns** | the schema | typed columns on `leads` | Yes — they gate behavior |
| **User columns** | the operator, in the UI | `leads.data` (JSONB) | No — they're freeform data |

The key idea, borrowed from Clay and fire-enrich: **a column is not just where a value
lives — it is the definition of *how that value gets filled.*** When an operator adds a
column, they choose its type:

| Column type | Fills itself by | Example |
|---|---|---|
| **Enrichment** | running a provider waterfall | `company_size` ← Apollo → Hunter → … |
| **Agent** | running the LLM tool-loop with a prompt | `recent_signal` ← "find their latest funding" |
| **Formula** | deriving from other columns | `icp_score` ← f(size, industry) |
| **Manual** | a human typing | `notes` |

```
Operator adds column "recent_funding"  (type: agent, prompt: "...")
        │
        ▼
   column definition saved  ──►  columns table
        │
        ▼
   Operator clicks "Run column"
        │
        ▼
   one enrichment/agent JOB per row  (run only if cell empty)
        │
        ▼
   { value, confidence, source_url }  written to leads.data->'recent_funding'
        │
        ▼
   column renders in the table, live, with a provenance link
```

This means **adding a column = defining a reusable job**, and **running a column = firing
that job across every row**. Values land in a single `data` JSONB field on the lead
(indexed with GIN for filtering), while the column *definitions* — name, type, the
waterfall or prompt that powers them — live in their own `columns` table. The lead stays
one canonical record; the table just gains columns.

> **Design note:** enrich *in place*, into the same `leads` row — never into a parallel
> `enriched_leads` table. A second table is a sync problem waiting to happen and breaks
> the single-source-of-truth rule. If you need history, use `audit_log`, not a copy.

---

## Working Flow — Stage by Stage

The stages are *operations*, not a rigid pipeline. An operator can run enrichment on one
row, a filtered batch, or the whole table — and re-run any stage at any time without
rebuilding anything. Each stage below is one or more **jobs**.

### 1 · Ingestion

A lead enters through CSV, API, webhook, CRM sync, or manual entry. Fetch normalizes the
incoming shape into the canonical schema, checks for an existing match, and either merges
or creates. Only then does it decide what work is needed.

```
Input (company / person data)
        │
        ▼
   Normalize to canonical schema
        │
        ▼
   Dedupe check  ──► exists? ──► merge / update existing lead
        │
        ▼ (new)
   Canonical Lead Row in Postgres
        │
        ▼
   Enqueue jobs  (enrich? validate? both?)
```

The decision at the bottom matters: ingestion **does not force a sequence**. If a lead
arrives with a verified email already, validation may be skipped. If it arrives with only
a name and company, an enrichment job is created first. Jobs are created based on *what's
missing*, not a fixed order.

### 2 · Enrichment — the centerpiece

This is where Fetch behaves like a research engine. Each missing field is resolved by a
**waterfall**: providers are queried in cost-ascending order, and **the moment one returns
a valid value, the waterfall stops** — you only pay for hits. When the structured
providers all miss, an **agentic LLM research loop** takes over: it can search, scrape,
read, and extract until it finds the field or hits its step limit.

```
Canonical Lead Row  (fields marked "missing")
        │
        ▼
   ┌──────────────────────── WATERFALL (per field) ────────────────────────┐
   │  Provider A ──hit?──► YES ─────────────────────────────────────► STOP   │
   │      │ no                                                               │
   │  Provider B ──hit?──► YES ─────────────────────────────────────► STOP   │
   │      │ no                                                               │
   │  Provider C ──hit?──► YES ─────────────────────────────────────► STOP   │
   │      │ no (structured sources exhausted)                                │
   │      ▼                                                                  │
   │  ┌──────────────────────────────────────────────┐                      │
   │  │  AGENT PROMPT                                  │                      │
   │  │  "find: company_size, recent_signal, title"   │                      │
   │  │            │                                   │                      │
   │  │            ▼                                   │                      │
   │  │  ┌─────────────────────────────┐              │                      │
   │  │  │  LLM (Claude / GPT)          │              │                      │
   │  │  │  + Tool-Calling Loop         │              │                      │
   │  │  │   - web_search()             │              │                      │
   │  │  │   - scrape_url()             │              │                      │
   │  │  │   - read_linkedin()          │              │                      │
   │  │  │   - extract_field()          │              │                      │
   │  │  │   - enrichment_api()         │              │                      │
   │  │  └─────────────────────────────┘              │                      │
   │  │            │ loops until found or step-limit   │                      │
   │  └────────────┼───────────────────────────────────┘                     │
   └───────────────┼─────────────────────────────────────────────────────────┘
                   ▼
        Structured Output  { value, confidence, source_url }
                   │
                   ▼
        Field Merge  (write only if empty / higher confidence)
                   │
                   ▼
        Update Lead Cell(s) + record provenance + set enrichment_status
```

Three rules keep this sane and cheap:

| Rule | Effect |
|---|---|
| **Run only if empty** | Never re-pay to fill a field that's already populated. |
| **Stop on first hit** | The waterfall halts the instant a valid value is found. |
| **Confidence + provenance** | Every value carries how sure it is and where it came from. |

The LLM never returns prose. It returns **structured output that writes directly into a
cell** — `company_size: 240`, `recent_signal: "raised Series B Mar 2026"`. The output is
the data, not a paragraph about the data.

### 3 · Validation

Validation runs after enrichment (or in parallel, when an email already exists). It
decides whether a lead is *safe to send to*, which gates everything downstream.

```
Lead with email
        │
        ▼
   Syntax check ──► fail ──► status: invalid
        │ pass
        ▼
   MX record check ──► fail ──► status: invalid
        │ pass
        ▼
   SMTP / mailbox reachability ──► fail ──► status: risky / bounced
        │ pass
        ▼
   Disposable-domain check ──► hit ──► status: disposable
        │ clear
        ▼
   Catch-all + duplicate check
        │
        ▼
   Validation status: valid · risky · invalid · disposable · duplicate · no_email
```

Only `valid` (and, by policy, `risky` if the operator opts in) leads become eligible for
a campaign. This is the layer that stops bad data from ever reaching a send adapter.

### 4 · Personalization

Once a lead is enriched and validated, Fetch generates the actual outreach. The operator
supplies a **campaign template** with variables; the LLM fills it using the lead's fields,
account context, and signals discovered during enrichment.

```
Validated Lead
        │
        ▼
   Campaign Template + Variables  ({{first_name}}, {{recent_signal}} …)
        │
        ▼
   Prompt Builder  (lead context + account context + prompt version)
        │
        ▼
   LLM Draft  → { subject, opener, body, cta }
        │
        ▼
   Guardrails ──► fail ──► flag for review
   (length · missing variables · banned claims · tone)
        │ pass
        ▼
   Write subject + body back to Lead Row  (state: draft → ready)
        │
        ▼
   Human preview / approve  (in the UI)
```

The generated message is **written back to the lead row** — personalization is a visible
data artifact, not an invisible step. An operator can read it, edit it, and approve it
before anything is queued for sending.

### 5 · Sending

Sending is a first-class stage with its own job type, not an export button. Approved
leads are mapped into the payload shape the chosen provider expects, through an
**adapter** so the internal model never changes when you switch rails.

```
Approved Lead (subject + body + campaign)
        │
        ▼
   Send Job enqueued
        │
        ▼
   ┌──────────── ADAPTER LAYER ────────────┐
   │  selects provider for this campaign    │
   │                                        │
   │   Instantly adapter ──► POST /api/v2/leads (bulk, ≤1000)         │
   │       custom_variables, skip_if_in_workspace, verify_on_import   │
   │                                        │
   │   Smartlead adapter ──► add leads to campaign + sequence          │
   │                                        │
   │   Generic adapter   ──► SMTP / webhook                            │
   └────────────────┬───────────────────────┘
                    ▼
        Provider accepts  ──► store provider_lead_id + send_status: sent
```

Because Fetch holds the canonical record, it sends only the fields a provider needs and
keeps everything else local. Start on Instantly, add Smartlead later, and the campaign
logic above the adapter never changes.

### 6 · Event Feedback

After sending, providers push events back. Fetch exposes a webhook endpoint per provider,
**normalizes** each provider's event names into one internal vocabulary, and writes to the
`events` table — then updates the lead and campaign metrics.

```
Instantly / Smartlead  ──webhook──►  POST /webhooks/{provider}
        │
        ▼
   Verify signature  +  idempotency check (dedupe by provider event id)
        │
        ▼
   Normalize event name
     EMAIL_OPEN | EMAIL_OPENED        → opened
     EMAIL_LINK_CLICK | clicked       → clicked
     EMAIL_REPLY | replied            → replied
     EMAIL_BOUNCED | bounced          → bounced
     LEAD_UNSUBSCRIBED                → unsubscribed
        │
        ▼
   Insert into events table  (lead_id, type, provider, payload, ts)
        │
        ▼
   Update Lead Row state  (replied_at, bounced_at, …)
        │
        ▼
   Update Campaign metrics  →  UI is live
```

One thing the research made obvious: **Smartlead's webhook payload is intentionally
sparse** — it sends an email and a campaign id, not the full lead. That's a non-issue for
Fetch, because Fetch *is* the lead store. We match the inbound event to the local lead by
email/provider id and already have the full context. (Providers retry failed deliveries a
few times only, so the endpoint must ACK fast and process asynchronously.)

---

## Job Orchestration

Everything slow is a **job**. Jobs are rows in Postgres claimed by workers using
`SELECT … FOR UPDATE SKIP LOCKED`, so multiple workers drain the same queue without
stepping on each other — and **no Redis is required**, which keeps a self-host deploy to
a single Postgres + the app.

| Job property | Purpose |
|---|---|
| `type` | enrich · validate · personalize · send |
| `status` | queued · active · completed · failed · dead |
| `lead_id` / `campaign_id` | what the job acts on |
| `attempts` / `retry_backoff` | retry with jitter on transient failure |
| `error` | last failure reason, surfaced in the Job Monitor |
| `dead_letter` | terminal failures land here for inspection / replay |

Why job-based matters: if one enrichment provider times out, the lead row still exists,
the rest of the table is untouched, and the operator can retry just that cell. Failure is
contained to a job, never the dataset.

| Trigger | Scope |
|---|---|
| Operator clicks a cell | one job, one lead |
| Operator selects a filter | batch of jobs |
| Operator runs the table | jobs fan out across the whole dataset |
| Inbound webhook | event-intake job |

---

## Connector & Adapter Layer

Two distinct adapter families, both behind stable interfaces so the core never learns a
vendor's quirks.

| Direction | Adapter | Speaks |
|---|---|---|
| **In** | CSV / API / webhook / manual | raw lead payloads → normalizer |
| **In** | CRM (HubSpot, Salesforce) | bidirectional lead sync |
| **Enrich** | Apollo, Hunter, Findymail, Dropcontact, … | waterfall provider calls |
| **Validate** | ZeroBounce / MX / SMTP | deliverability checks |
| **Out** | Instantly | `POST /api/v2/leads`, custom vars, webhooks |
| **Out** | Smartlead | add-to-campaign, sequence, webhooks |
| **Out** | Generic | SMTP / outbound webhook |

Adding a new send provider = writing one adapter that implements `push(leads, campaign)`
and `parseEvent(payload)`. Nothing above the adapter changes.

---

## Database Schema

```
leads ──────────────────────────────────────────────────────────
  id                cuid       PK
  account_id        cuid?      FK → accounts.id
  source_id         cuid       FK → sources.id
  first_name        string?
  last_name         string?
  email             string?
  phone             string?
  title             string?
  linkedin_url      string?
  enrichment_status string     (pending/running/done/failed)
  enrichment_conf   jsonb      ← per-field confidence + source URLs
  validation_status string     (valid/risky/invalid/disposable/duplicate/no_email)
  subject           string?    ← personalization output
  body              text?      ← personalization output
  prompt_version    string?
  approval_status   string     (draft/ready/approved/rejected)
  campaign_id       cuid?      FK → campaigns.id
  provider          string?    (instantly/smartlead/smtp)
  provider_lead_id  string?
  send_status       string     (none/queued/sent/failed)
  sent_at           datetime?
  opened_at         datetime?
  clicked_at        datetime?
  replied_at        datetime?
  bounced_at        datetime?
  unsubscribed_at   datetime?
  data              jsonb      ← ALL user-defined columns live here (GIN-indexed)
  created_at        datetime
  ── everything above `data` is a SYSTEM column; everything inside it is a USER column ──

columns ─────────────────────────────────────────────────────────
  id          cuid    PK
  key         string  UNIQUE   ← the JSONB key written into leads.data
  label       string           ← display name in the table
  type        string  (enrichment/agent/formula/manual)
  config      jsonb            ← waterfall provider order, or agent prompt, or formula
  created_at  datetime

accounts ───────────────────────────────────────────────────────
  id          cuid    PK
  domain      string  UNIQUE   ← dedupe key for companies
  name        string
  industry    string?
  size        int?
  tech_stack  string[]
  signals     jsonb            ← funding, hiring, news
  created_at  datetime

campaigns ──────────────────────────────────────────────────────
  id           cuid    PK
  name         string
  provider     string  (instantly/smartlead/smtp)
  provider_ref string?          ← external campaign id
  template_id  cuid    FK → prompts.id
  rules        jsonb            ← eligibility (e.g. only validation_status=valid)
  status       string  (draft/active/paused)
  created_at   datetime

sequences ──────────────────────────────────────────────────────
  id          cuid    PK
  campaign_id cuid    FK → campaigns.id
  step        int
  wait_days   int
  prompt_id   cuid    FK → prompts.id

jobs ───────────────────────────────────────────────────────────
  id            cuid     PK
  type          string   (enrich/validate/personalize/send/event)
  lead_id       cuid?    FK → leads.id
  campaign_id   cuid?    FK → campaigns.id
  status        string   (queued/active/completed/failed/dead)
  attempts      int      default 0
  error         text?
  created_at    datetime
  completed_at  datetime?

events ─────────────────────────────────────────────────────────
  id            cuid     PK
  lead_id       cuid     FK → leads.id
  campaign_id   cuid?    FK → campaigns.id
  type          string   (sent/opened/clicked/replied/bounced/unsubscribed)
  provider      string
  provider_evt  string   UNIQUE   ← idempotency key
  payload       jsonb
  created_at    datetime

prompts ────────────────────────────────────────────────────────
  id          cuid    PK
  name        string
  version     int
  body        text             ← template w/ {{variables}}
  guardrails  jsonb            ← max length, banned claims, required vars
  created_at  datetime

sources ────────────────────────────────────────────────────────
  id          cuid    PK
  type        string  (csv/api/webhook/crm/manual)
  raw         jsonb            ← original payload as received
  created_at  datetime

audit_log ──────────────────────────────────────────────────────
  id          cuid    PK
  actor       string  (user id / system / job id)
  entity      string  (lead/campaign/job …)
  entity_id   cuid
  action      string  (create/update/approve/send …)
  diff        jsonb
  created_at  datetime
```

---

## End-to-End Data Flow Summary

| Stage | Input | Process | Output |
|---|---|---|---|
| **Ingest** | CSV / API / webhook / CRM | normalize + dedupe | canonical lead row |
| **Enrich** | lead row + agent prompt | waterfall → AI tool loop | structured fields + confidence |
| **Validate** | email / domain | syntax · MX · SMTP · disposable | validation status |
| **Personalize** | lead + template | LLM draft + guardrails | subject + body (draft → ready) |
| **Send** | approved lead | adapter → provider API | sent message + provider id |
| **Track** | provider webhook | normalize + dedupe | event row + updated lead state |

This table *is* the architecture: one record moving left-to-right through six operations,
writing back to the same place each time.

---

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Source of truth | **Postgres 18** | One store for state, jobs, and events. |
| Job queue | **pg-boss** (in Postgres) | `SKIP LOCKED` dequeue, no Redis, simple self-host. |
| API + workers | **TypeScript** (separate processes) | API stays fast; workers scale independently. |
| ORM | **Drizzle** (Prisma also fine) | Type-safe Postgres access, swappable. |
| Web UI | **Next.js (App Router)** | Table-first operator workspace. |
| LLM | **provider-agnostic** (Claude / GPT) | Reasoning + extraction + copy, behind one interface. |
| Enrichment | **provider waterfall** + agent loop | High coverage at low cost. |
| Deploy | **Docker Compose / single VPS** | Self-hostable by default. |

The deliberate constraint: **the minimum viable deploy is one Postgres + the app.** No
Redis, no extra broker, no proprietary workspace. That's what "self-hostable open source"
has to mean in practice.

---

## UI Surfaces

| Screen | Purpose |
|---|---|
| **Lead table** | Review, edit, filter, and trigger any stage per row or batch. |
| **Account view** | Company context + every lead attached to it. |
| **Campaign builder** | Template, targeting, rules, provider selection. |
| **Prompt editor** | Versioned prompts + guardrails for enrichment and copy. |
| **Job monitor** | Live job status, errors, retries, dead-letter inspection. |
| **Reply inbox** | Replies, bounces, unsubscribes surfaced from events. |
| **Analytics** | Deliverability, engagement, conversion per campaign. |

Table-first, but **not spreadsheet-first.** Fetch owns the experience; the table is a view
over the data model, not a Baserow instance with automations bolted on.

---

## Locked Decisions

1. **Postgres is the single source of truth** — every layer reads and writes the same rows.
2. **The API never does slow work** — it writes a row and enqueues a job; workers do the rest.
3. **Enrichment is a waterfall + agent loop** — stop on first hit, run only if empty, always record confidence + provenance.
4. **Validation gates sending** — only `valid` (opt-in `risky`) leads are campaign-eligible.
5. **Personalization is a stored artifact** — written to the lead row, previewable and approvable before send.
6. **Sending is behind an adapter** — Instantly / Smartlead / SMTP are interchangeable; the core never learns a vendor's shape.
7. **Events are normalized on intake** — one internal vocabulary, idempotent by provider event id.
8. **No Redis in the baseline** — the queue lives in Postgres so a self-host is one DB + the app.
9. **Columns are user-definable** — system columns are fixed and gate behavior; everything else is a user column in `leads.data`, where a column = a reusable enrichment/agent/formula job.
10. **Enrich in place** — values are written back into the same `leads` row, never a parallel `enriched_leads` table. History lives in `audit_log`.

---

## What Fetch Deliberately Is *Not*

| Not this | Because |
|---|---|
| A Baserow + automations stack | The product owns its own UI and data model. |
| An Instantly/Smartlead wrapper | Those are delivery rails behind an adapter, not the center. |
| A full CRM replacement | Out of scope for v1 — Fetch syncs *with* CRMs. |
| A send-anything machine | Validation gates every send. |
| Locked to one LLM or one enrichment vendor | Everything external sits behind a swappable interface. |

The positioning line: **Fetch is an open-source GTM OS that replaces the brittle handoff
between enrichment tools, spreadsheets, personalization tools, and outreach platforms.**
Clay is the conceptual reference for enrichment; Instantly and Smartlead are integrations.

---

## MVP Build Order

1. **Canonical schema + CSV import + dedupe** — get one lead reliably into Postgres.
2. **Job system (pg-boss) + worker pool** — the spine everything else hangs off.
3. **Enrichment: agent tool-calling loop** — one provider + AI fallback, with confidence/provenance.
4. **Validation + dedupe** — make lists safe to send.
5. **Template personalization + preview/approve** — visible, editable drafts.
6. **One send adapter (Instantly)** — prove the rail end-to-end.
7. **Webhook intake + normalized events** — close the loop so the UI goes live.
8. **Table UI + analytics; add Smartlead adapter** — second rail proves the abstraction holds.

Each step ships something usable. By step 7 the product is already an end-to-end GTM OS;
everything after is coverage and polish.
