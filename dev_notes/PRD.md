# Fetch — Product Requirements Document
*Version 1.0 — June 2026*

---

## 1. Problem

Modern GTM is a stack of five tools held together with CSV exports and someone manually
patching CRM fields late at night. A lead's data lives in an enrichment tool, its email
status in a spreadsheet, its copy in a doc, and its send state in an outreach platform —
and none of them agree with each other.

The concrete failures this creates:

- **Data fragmentation** — the same lead exists in four tools with four versions of the truth.
- **Brittle handoffs** — every export/import between tools is a place data rots or breaks.
- **No observability** — when an enrichment or send fails, nobody knows until a campaign underperforms.
- **Vendor lock-in** — the outreach platform owns your data model, so switching rails means rebuilding.
- **Cost opacity** — enrichment credits burn with no view into what was paid for or why.

---

## 2. Solution

Fetch is an **open-source, self-hostable GTM operating system**. A lead enters once and
Fetch owns its whole life — ingest, enrich, validate, personalize, send, and learn — as
operations on **one canonical record** in Postgres.

The reference point everyone already understands is **Clay**: a table you operate from,
waterfall enrichment, AI research per cell. Fetch takes that model, makes it
self-hostable and open, and extends it downstream into sending. **Instantly and Smartlead
are delivery integrations behind an adapter — not the product.**

The one-line positioning: *Fetch replaces the brittle handoff between enrichment tools,
spreadsheets, personalization tools, and outreach platforms with a single system where
every lead is a live object.*

---

## 3. Goals and Non-Goals

| Goals | Non-Goals (v1) |
|---|---|
| One canonical lead record, Postgres as source of truth | Replace the CRM entirely |
| Clay-style user-definable columns with AI/provider fills | Omnichannel sequencing (LinkedIn, SMS, calls) |
| Structured, observable, retryable enrichment + personalization | Pipeline forecasting / deal management |
| Swappable delivery rails (Instantly, Smartlead, SMTP) | Team billing, granular enterprise permissions |
| Full event feedback loop back into the same record | A hosted multi-tenant SaaS (self-host first) |
| Self-hostable with no exotic infra (one Postgres + the app) | Being locked to one LLM or one enrichment vendor |

---

## 4. Target Users

| Persona | What they need | Why Fetch fits |
|---|---|---|
| **GTM engineer** | Flexible workflows, APIs, automation control | Owns the whole motion as code + columns, not glued tools |
| **Founder / solo operator** | A self-hosted outbound stack with low tool sprawl | One system instead of five subscriptions |
| **Sales rep** | Fast lead prep, personalization, sending | Review → approve → send in one table |
| **RevOps** | Data quality, tracking, auditability | Validation gates + audit log + event history |

---

## 5. User Stories

- As a GTM engineer, I import a list and add a column that auto-enriches every row, so I stop doing manual research.
- As a GTM engineer, I want each enriched cell to show its confidence and source, so I can trust the data.
- As a sales rep, I preview the AI-personalized email per lead and approve it, so quality stays high.
- As a founder, I route sends through Instantly today and Smartlead later without rebuilding my data, so I'm not locked in.
- As a RevOps lead, I want replies, bounces, and unsubscribes to sync back automatically, so performance lives in one place.
- As an operator, I rerun a failed enrichment on one row without touching the rest of the table, so failures are contained.
- As a self-hoster, I want to stand the whole thing up with one Postgres and the app, so deployment isn't a project.

---

## 6. Functional Requirements

| Area | Requirement |
|---|---|
| **Ingestion** | Import leads from CSV, API, webhook, CRM, and manual entry; normalize all sources into one schema. |
| **Dedupe** | Match on email (lead) and domain (account); merge on match, create otherwise; never duplicate on re-import. |
| **Dynamic columns** | Operators create columns of type enrichment, agent, formula, or manual; values stored per row. |
| **Enrichment** | Provider waterfall (stop on first hit) with an LLM agent loop fallback; run only if empty. |
| **Provenance** | Every enriched value stores confidence and a source URL. |
| **Validation** | Syntax, MX, SMTP/mailbox, disposable, catch-all, and duplicate checks; produces a gating status. |
| **Personalization** | Templated, versioned prompts generate subject/body per lead with guardrails and approval. |
| **Campaigns** | Define template, targeting rules, sequence, and provider per campaign. |
| **Sending** | Push approved + valid leads to Instantly/Smartlead/SMTP through a common adapter. |
| **Events** | Ingest opens, clicks, replies, bounces, unsubscribes via webhooks; normalize and store. |
| **Orchestration** | All slow work runs as retryable, observable jobs; run per row, per filter, or per table. |
| **UI** | Table-first workspace: filter, edit, run-cell/column, approve, monitor jobs, read replies, see analytics. |
| **Audit** | Every state change is recorded with actor, action, and diff. |

---

## 7. Non-Functional Requirements

| Requirement | Target |
|---|---|
| **Self-hostable** | One Postgres + the app; no Redis or extra broker in the baseline. |
| **Source of truth** | Postgres holds all state, jobs, and events; enrichment happens in place. |
| **Resilience** | Jobs retry with backoff; failures land in a dead-letter queue; crashes never lose work. |
| **Idempotency** | Every background handler and webhook is safe to run twice. |
| **Observability** | Job status, errors, and per-job logs are visible; dead-letter is inspectable. |
| **Modularity** | New connectors, providers, and send rails plug in behind stable interfaces. |
| **Security** | Secrets via env only; webhooks verify signatures; public endpoints are rate-limited. |
| **Portability** | No dependency on a proprietary workspace or vendor data model. |

---

## 8. Scope — MVP

| In scope (MVP) | Out of scope (post-MVP) |
|---|---|
| CSV import + manual entry | Full HubSpot/Salesforce bidirectional CRM sync |
| Canonical lead store + dedupe | Advanced multi-touch omnichannel sequencing |
| Dynamic columns (all four types) | Complex pipeline forecasting |
| Enrichment waterfall + agent loop | Enterprise permissions / workspace billing |
| Validation with gating | Hosted multi-tenant SaaS offering |
| Templated personalization + approval | A/B copy optimization at scale |
| One send adapter (Instantly) | — |
| Webhook event ingestion | — |
| Table-first UI + basic analytics | — |
| Second adapter (Smartlead) to prove the abstraction | — |

---

## 9. Success Metrics

| Metric | What it tells us |
|---|---|
| **Time to first send** | How fast a new user goes raw-data → sent. Lower is better. |
| **Enrichment coverage %** | Share of requested cells filled with a valid value. |
| **Cost per enriched lead** | Avg spend across providers + LLM per lead. Cost-control working? |
| **Validation accuracy** | Bounce rate of leads marked `valid`. Lower means the gate works. |
| **Job success rate** | Completed vs dead-lettered jobs. System health. |
| **Re-run rate** | How often operators rerun a stage — a proxy for trust/quality. |
| **Adapter portability** | Can a campaign switch providers with zero core changes? Yes/no. |

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agentic enrichment cost runs away | Waterfall before agent, run-only-if-empty, per-job step + cost ceilings, caching. |
| Bad data reaches outreach and burns domains | Validation is a hard gate; only `valid` (opt-in `risky`) is sendable. |
| Provider API changes break sending | Adapter pattern isolates each vendor; core never learns vendor shapes. |
| Self-host is too complex to adopt | No Redis baseline; one-command Docker Compose; tested README. |
| LLM output quality is inconsistent | Versioned prompts + guardrails + human preview/approve before send. |
| Webhook spoofing or duplicate events | Signature verification + idempotency key per provider event. |

---

## 11. Release Plan

The build follows the phased plan in `CHECKLIST.md`. The product is MVP-complete when the
full loop is operable end to end and a second send rail works without core changes.

| Milestone | Delivers |
|---|---|
| **M1 — Spine** | Foundation, canonical model, ingestion, dedupe, job system. |
| **M2 — Intelligence** | Dynamic columns, enrichment (waterfall + agent), validation. |
| **M3 — Outreach** | Personalization, Instantly sending, webhook event feedback. |
| **M4 — Workspace** | Table-first UI, analytics. |
| **M5 — Proof + ship** | Smartlead adapter, hardening, self-host docs. |

---

## 12. Open Questions

- Which enrichment providers ship in the default waterfall, and in what cost order?
- Is multi-tenancy a v1 concern or strictly self-host-single-tenant first?
- Default LLM provider out of the box, and how is the key supplied for self-hosters?
- How much campaign/sequence logic lives in Fetch vs delegated to the send provider?
- What is the minimum analytics set for MVP vs deferred?

---

*Document 1 of 3 — PRD*
*See also: ARCHITECTURE.md / WORKING.md*
