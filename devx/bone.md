# Bone & Dogi — the two-agent architecture 🐕

> Status: **PLANNING** — agreed direction, not yet built. This doc is the
> architecture-of-record for *how the agent layer is split*. The cell agent's
> mechanics live in [dogi-agent.md](./dogi-agent.md); this doc sits above it.

## TL;DR

We were overloading **one** agent ("Dogi") with **two** jobs. We split them:

- **Dogi** — the **cell primitive** and the **interaction layer**. Fills *one
  field for one row* with provenance. Narrow, reliable, auditable. The single
  surface the GUI, MCP, and Bone all go through to touch Fetch.
- **Bone** — the **autonomous orchestrator**. Takes a goal, decides what to do,
  and acts by *creating rows*, *creating/configuring columns*, *picking & tuning
  a Dogi per column*, and *planning & chaining* — using Dogi as its hands.

> **Naming:** we keep **Bone** / **Dogi** for now (one letter apart — cute as a
> brand, a known confusion risk in code/logs/docs). May rename later. In today's
> codebase the identifier is `dogi` — read that as **Dogi**.

---

## 1. Why this doc exists — the problem that triggered it

A real prompt to the agent on the **"Tech wodooo"** table:

> *"Create a list of the top 10 companies in the world, their CEOs, and the
> LinkedIn profiles of those CEOs. Map it into relevant columns."*

What happened (traced in Postgres):

| Step | Result |
|---|---|
| Goal → planner | ✅ created 3 dogi columns: `top_10_companies`, `ceo_names`, `ceo_linkedin_profiles` (correctly chained via `dependsOn`) |
| Rows in the table | ❌ **0** |
| Enrichment jobs run | ❌ **none** |
| Cells filled | ❌ **none — "no rows yet"** |

The planner's own system prompt says it literally:

> *"You decompose the GOAL into an ordered list of steps, each of which becomes
> ONE new column that an agent fills **for every lead**."*

So with **zero leads**, there was nothing to fill — and "top 10 companies" got
crammed into the semantics of *one cell per row* instead of becoming *ten rows*.

## 2. The realization — two modes of action

The agent today only knows **one** verb:

- **ENRICH** *(have)* — given existing rows, fill columns. This is Dogi.
- **SOURCE / GENERATE ROWS** *(missing)* — given a description, **create the
  entities** ("the top 10 companies"). Nobody owns this.

This is exactly the Clay split: **"Find companies/people" sources** (which create
rows) vs **enrichment columns** (which fill them). "Make me a list of N X" is a
*row-sourcing* task, not a cell task — which is why it can't live in Dogi.

---

## 3. The two agents

| | **Dogi** — the hands | **Bone** — the brain |
|---|---|---|
| **Scope** | one field, one row | a whole goal across a table |
| **Determinism** | narrow, predictable, testable | open-ended, autonomous |
| **Can create rows?** | **No** (no concept of rows) | **Yes** — this is the headline new power |
| **Can create/config columns?** | No | Yes — incl. choosing & tuning the Dogi for each |
| **Plans multi-step?** | No | Yes — decompose, order by `dependsOn`, run, chain |
| **Provenance** | value + confidence + source on every cell | inherits Dogi's, plus an action log |
| **Who calls it** | Bone, the GUI (per-cell run), MCP | a human, the GUI "Ask Bone", MCP, (later) a schedule |
| **Today** | exists, works (verified live) | partially exists as the planner; needs row-sourcing + autonomy |

**Bone is a strict superset of Dogi** — it can always fall back to "just run a
plain Dogi on this cell." Keeping them separate keeps Dogi simple to trust and
test while Bone is free to be ambitious.

## 4. Layered architecture

```
   GUI (humans)        MCP client (external AI)        a schedule / API caller
        \                      |                              /
         \                     |                             /
          ▼                    ▼                            ▼
        ┌─────────────────────────────────────────────────────┐
        │  BONE — autonomous orchestrator ("what should I do?")│
        │   • SOURCES / CREATES rows        ← the gap we found  │
        │   • creates & configures columns                      │
        │   • picks / tunes a Dogi per column                  │
        │   • plans a goal, orders by dependsOn, runs & chains  │
        │   • default: PROPOSE a plan → you approve  (toggle: just-do-it) │
        └───────────────────────────┬─────────────────────────┘
                                     │ calls, per cell  +  table ops
                                     ▼
        ┌─────────────────────────────────────────────────────┐
        │  DOGGI — cell primitive  &  interaction layer         │
        │   fill ONE field for ONE row, with provenance         │
        │   sources(provider/web/scrape/llm) · policy · brain   │
        └───────────────────────────┬─────────────────────────┘
                                     ▼
        ┌─────────────────────────────────────────────────────┐
        │  FETCH PRIMITIVES  (the shared tool layer)            │
        │   tables · rows · columns · run-cell · audit_log      │
        │   Postgres = single source of truth                   │
        └─────────────────────────────────────────────────────┘
```

The bottom two layers are the **interaction surface**: one set of primitives that
the GUI, Bone, and MCP all use. That is what "Dogi is the layer between the
MCP, the GUI, and the Fetch app" means in practice.

## 5. How Bone works

1. **Take a goal** (natural language) on a table — e.g. *"top 10 AI infra
   companies, their CEOs, and CEO LinkedIn URLs."*
2. **Plan.** Decompose into steps. Some steps are **row-sourcing** (create the 10
   companies as rows), others are **columns** (CEO, LinkedIn) with a Dogi config.
3. **Propose → approve (default).** Bone shows the plan — *"I'll create ~10 rows
   from ‘top 10 AI infra companies’, add columns CEO and CEO LinkedIn, and run
   them."* You approve. **A toggle flips this to "just do it"** (autonomous, no
   approval) for users who trust it.
4. **Execute.** Create rows → create columns → run Dogis in `dependsOn` order
   (reuse today's dependency-ordered worker). Each cell carries provenance.
5. **Log.** Every action (rows created, columns added, cells filled, plan chosen)
   is written to `audit_log` and surfaced in an **Agent activity log** view.

**Configurable settings.** Bone exposes *its own* settings **and** the default
**Dogi** config it hands to the columns it builds — provider/model (brain),
web-search on/off, sources, policy, propose-vs-auto. So "configure Bone" =
configure both the orchestrator and the cell agent it spawns.

## 6. How today's pieces map onto this

| Today | Becomes | Work needed |
|---|---|---|
| `packages/agent` cell run (`runDogi`) | **Dogi** | none — it *is* Dogi (rename later) |
| `planner.ts` + `/ask-dogi` + `/apply-plan` (creates+chains columns "for every lead") | early **Bone** | promote: add **row-sourcing**, add the propose/auto toggle, broaden "for every lead" to "operate the table" |
| `audit_log` (already written on every action) | the **Agent log** data | surface it in a view |
| per-table dedupe + dedupe-existing | a table op Bone can call | already built |

We don't throw anything away — we **re-home the planner into Bone** and give
Dogi back its single job.

---

## 7. Does Bone need MCP to function? — **No.**

Short answer: **Bone runs inside Fetch and calls the primitive layer directly,
in-process. It needs zero MCP.** MCP is an *optional projection* of the same
primitives, useful two independent ways:

1. **Fetch as an MCP _server_** — expose the primitive layer so an *external* AI
   (Claude, etc.) can drive Fetch from outside. Bone and an external MCP client
   then become **two consumers of the same primitives** — siblings, not a stack.
2. **Fetch as an MCP _client_** — let Bone/Dogi *use* external MCP servers as
   extra tools (a CRM, a niche search server). Purely additive capability.

**Design consequence:** build the **primitive/tool layer once** (table ops +
Dogi cell-fill). Bone calls it natively; MCP is a thin adapter that wraps the
*same* layer. So MCP is "a door in and a door out," never the engine — and it
comes almost for free once the primitives are clean. Full plan: [mcp.md](./mcp.md).

---

## 8. Decisions locked in this session (2026-06-06)

- **Two agents, kept separate:** **Dogi** (cell primitive / interaction layer) +
  **Bone** (autonomous orchestrator). Bone is a superset that uses Dogi.
- **Row-sourcing is a Bone capability** ("make a list of N X" creates rows, then
  Dogi fills the columns). This is the headline next feature.
- **Bone defaults to propose-a-plan** (like Ask-Dogi today) with a **toggle to
  "just do it"** (autonomous).
- **Bone's settings are configurable** — both its own and the default Dogi
  config it gives the columns it builds.
- **Names:** Bone / Dogi for now; revisit later. Code identifier `dogi` = Dogi.
- **MCP is optional**, a projection of the shared primitive layer; Bone does not
  depend on it.
- **A new table starts with one blank row** (index shows `1`), so it's never a
  dead end. (See [leads-grid.md](./leads-grid.md).)

## 9. Open questions

- Row-sourcing **count & stopping rule**: when the user says "top 10," is 10 a
  hard cap, a target, or a hint? What about "all the YC W24 companies"?
- **Dedup on sourced rows** — sourcing the same list twice should reuse, not
  duplicate (ties into per-table dedupe + dedupe-existing).
- Where Bone lives in the **nav/UX**: a mode on the table ("Ask Bone"), or its
  own surface alongside the Agents page?
- Cost/guardrails for autonomous "just do it" runs (row count × column count ×
  brain cost) — reuse the cost estimate + a ceiling/confirm.

## 10. Related fixes surfaced by the same review

These came out of the same conversation; tracked in
[roadmap.md](./roadmap.md) and the main checklist:

- **Default blank row + index** on new tables (above).
- **Loading state** while an agent works — the cell machine already has
  `queued → running` and `/cell-jobs` polling; make `running` visually obvious.
- **Agent activity log** view over `audit_log`.
- **Overview as a list**, not cards (revisit a past decision).
- **Config-modal status — investigated & cleared:** the Dogi config modal is
  **not** "only visual." A manually-created dogi column persists its full config
  (`sources`/`policy`/`instruction`) in Postgres, the form emits `brain` on
  change, and `runDogi` provably consumes all of it (verified live). If a
  *specific* toggle ever looks ignored, trace that one field.
