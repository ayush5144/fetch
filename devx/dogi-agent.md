# Dogi — the fetch agent 🐕

**Fetch** is a dog that **fetches**. **Dogi** is the agent you send to get data.
This doc is the working spec: what Dogi is, how it runs, how a user customizes it
(simple and advanced), how it can **create columns and chain a goal**, and how it
maps onto the code we already have.

---

## 1. Mental model

> **A column is a saved Dogi.** Running a column sends that Dogi across every row.
> **A goal is a pack of Dogis** — Dogi can decompose a request into several
> columns, **create them**, and fill them in order.

Two altitudes:

- **Cell Dogi** — fills **one** column (find an email; summarize two columns).
- **Goal Dogi (planner)** — you describe an outcome ("find the CEO's email and
  write him a custom email"); Dogi **plans the steps, creates the columns**
  (`ceo_email`, `custom_email`), and runs them in dependency order. You can also
  point any output at an **existing** column instead of creating a new one.

Same engine underneath; the planner just emits multiple cell-Dogis and the
columns to hold their outputs.

---

## 2. Anatomy (the simple cell config)

The default config is **deliberately tiny** — five things:

| Field | Meaning | Example |
|---|---|---|
| `instruction` | Plain-language task | "Find this company's CEO's email" |
| `reads` | Input columns Dogi can see | `["company", "domain"]` |
| `output` | Where the value goes (create or map — see §5) | new column `ceo_email` |
| `webSearch` | `off` \| `native` \| `serper` \| `firecrawl` | `native` |
| `brain` | `{ provider, model }` (+ optional BYOK key ref) | `{ anthropic, claude-opus-4-8 }` |

```
┌──────────────────────────── Dogi (a column) ───────────────────────────┐
│  instruction:  "Find the CEO's email"                                   │
│  reads:        company, domain                                          │
│  output:       ◉ new column "ceo_email"   ○ map to existing ▼          │
│  web search:   ◉ native  ○ off  ○ serper  ○ firecrawl                    │
│  brain:        Anthropic · claude-opus-4-8        key: env ▼            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. How Dogi runs (execution)

Two execution shapes, chosen automatically by whether tools are on:

### a) Transform (web search **off**) — one call, no tools
Pure LLM over the `reads` columns. Covers the **"aggregate/summarize two
columns"** case and the **"write an email from found fields"** case. Fast, cheap,
no network.

### b) Research loop (web search **on**) — tool-calling
The model proposes a search/scrape, we run it, feed results back, loop until a
confident value or the **step ceiling**. This is our existing `packages/agent`
loop, generalized.

```
reads + instruction
        │
        ▼
   ┌──────────── if webSearch != off ──────────┐
   │  LLM ──► [ search ] / [ scrape ] ──► back  │ (loop ≤ maxSteps)
   └────────────────────────────────────────────┘
        │
        ▼
   structured output { value, confidence, source } ──► write to the output column
```

Output is **always structured** — value into `leads.data[output]`, and
`{ confidence, source, provider }` into `enrichmentConf[output]`. The cell shows
value + confidence dot + source link.

---

## 4. Web search — two backends, user's choice

| `webSearch` | What runs | Needs |
|---|---|---|
| `off` | No tools — pure transform | LLM key |
| `native` | The **provider's own** web search tool | LLM key |
| `serper` | **Our** Serper (Google) search | `SERPER_API_KEY` |
| `firecrawl` | **Our** Firecrawl scrape/extract | `FIRECRAWL_API_KEY` |

`native` is the default (no extra keys). See
[providers-and-keys.md](./providers-and-keys.md).

---

## 5. Output mapping — fill, **create**, or map to existing

Every Dogi output is one of:

| Mode | Meaning | When |
|---|---|---|
| **Create new column** | Dogi makes a new column to hold its result (auto-named, editable) | the value is new to the table |
| **Map to existing** | Write into a column that already exists (pick from a dropdown) | you already have e.g. `outreach_email` |
| **Fill this column** | The plain cell-Dogi case — it *is* the column it fills | adding a single enrichment column |

So `output` is `{ mode: 'create' | 'map', key, label }`. On **create**, Dogi adds
the `columns` row (in this table) before/at first run; on **map**, it writes into
the chosen existing key. Creating columns is a **first-class thing Dogi can do**,
not a side effect.

**Guardrails:** new columns are **previewed and confirmed** before creation (no
silent column spam), names are de-duplicated, and creation is scoped to the
current table and written to `audit_log`.

---

## 6. Goal mode — Dogi plans and builds columns

This is the "mix things up" power: describe an outcome, Dogi builds the columns.

**Example:** *"Find the company CEO's email, then write a custom cold email to
him."*

```
Goal: "find CEO email, then write a custom email"
        │
        ▼  Dogi plans (and shows you the plan to approve)
   ┌───────────────────────── PLAN ─────────────────────────┐
   │ 1. ceo_email   (web: native)   reads: company, domain   │  → new column
   │ 2. custom_email(web: off)      reads: ceo_email,         │  → new column
   │                                company, first_name       │     (depends on 1)
   └─────────────────────────────────────────────────────────┘
        │ you approve / edit (rename, map step 2 → existing "outreach_email", etc.)
        ▼
   create the columns → run step 1 across rows → run step 2 (uses step 1's output)
```

How it works:
- A **"Ask Dogi"** entry point above the table takes the goal.
- Dogi returns a **plan**: an ordered list of cell-Dogis, each with its
  `instruction / reads / output / webSearch`, and **dependencies** (step 2 reads
  step 1's output column).
- You **review** the plan — rename columns, switch any output to *map-to-existing*,
  toggle web search, change the model, or drop a step.
- On approve, Dogi **creates the columns** and runs them in dependency order
  (a column only runs once its inputs are filled).

This is exactly "Dogi can create columns and chain them," with a human checkpoint
so it never runs away. Dependencies reuse the engine's run-only-if-empty + job
fan-out; nothing new in orchestration.

---

## 7. Saved Dogis (reusable agents)

Like prompts today, a Dogi (or a whole goal-plan) can be **named and saved**, then
reused across columns and tables.

- **Save**: "Save as agent" on a configured column or an approved plan → stored in
  an `agents` table (name, config/plan, owner).
- **Reuse**: "Use a saved agent" when adding a column or asking Dogi; it pre-fills
  (still editable).
- A saved Dogi *is* a saved enrichment; we also keep saving **prompts** (raw
  instruction text) for personalization.

---

## 8. Simple vs Advanced customization

### Simple (default)
The 5-field form (§2) for a cell, or the **Ask Dogi → review plan** flow (§6) for
a goal. Covers ~90% of cases — no flowcharts.

### Advanced — Typebot / n8n-style visual flow
A canvas where **nodes are steps** and **edges connect fields** — you wire which
column feeds which step and where each output lands (create/map). It's the same
plan from §6, made fully editable as a graph.

```
[ input: company,domain ]
        │
        ▼
   ┌──────────┐   urls   ┌──────────┐  text  ┌────────────┐
   │ Search   │─────────►│ Scrape   │───────►│ Extract    │──► output(create): ceo_email
   │ (Serper) │          │(Firecraw)│        │ "ceo email"│
   └──────────┘          └──────────┘        └────────────┘
                                                   │ ceo_email
                                                   ▼
                                            ┌────────────┐
                                            │ LLM: write │──► output(map): outreach_email
                                            │ cold email │
                                            └────────────┘
```

Node palette (advanced v1): **Input (column)**, **Web search**, **Scrape URL**,
**LLM step**, **Formula/transform**, **Branch (if/else)**, **Output
(create/map)**. The flow **compiles to the same plan/config** the simple forms
produce — advanced is just a richer author. Simple configs can "open in flow
editor" to graduate.

> Advanced is a **stretch** (Phase E). Simple cell + goal mode ship first.

---

## 9. Config schema (what gets stored)

A Dogi lives in `columns.config` (cell) or `agents.config` (saved). A goal-plan is
an ordered list of these plus deps.

```jsonc
// One cell-Dogi
{
  "kind": "dogi",
  "instruction": "Find the CEO's email for this company.",
  "reads": ["company", "domain"],
  "output": { "mode": "create", "key": "ceo_email", "label": "CEO email" },
  "webSearch": "native",            // off | native | serper | firecrawl
  "brain": { "provider": "anthropic", "model": "claude-opus-4-8", "keySource": "env" },
  "maxSteps": 6
}

// A saved goal-plan (Dogi builds these columns, in order)
{
  "kind": "dogi-plan",
  "goal": "find CEO email then write a custom email",
  "steps": [
    { "id": "s1", "instruction": "Find the CEO's email.",
      "reads": ["company","domain"], "output": { "mode": "create", "key": "ceo_email" },
      "webSearch": "native", "dependsOn": [] },
    { "id": "s2", "instruction": "Write a short custom cold email to the CEO.",
      "reads": ["ceo_email","company","first_name"],
      "output": { "mode": "create", "key": "custom_email" },
      "webSearch": "off", "dependsOn": ["s1"] }
  ],
  "flow": null                       // null = linear plan; object = advanced graph
}
```

---

## 10. How this maps to existing code

We **extend**, not rewrite:

| Need | Today | Change |
|---|---|---|
| The loop | `packages/agent/src/loop.ts` | accept `reads/output/webSearch/brain`; transform vs loop |
| Tools | `packages/agent/src/tools/` | add **native** web search per provider; keep serper/firecrawl as options |
| LLM client | `packages/llm` (anthropic, openai) | add **gemini, grok**; `webSearch` capability; **BYOK** key arg |
| Column types | `packages/columns` (4 types) | unify enrichment+agent → **`dogi`**; keep formula/manual |
| **Create columns** | columns CRUD exists (`POST /columns`) | let a Dogi run **create a column** (preview+confirm, audit) |
| **Goal plan** | — | a **planner** (LLM) that emits the `dogi-plan`; run steps in dep order |
| Save/reuse | `prompts` table | add **`agents`** table (saved Dogis + plans) |
| Run on rows | `columns/engine.ts` (fan-out, run-only-if-empty) | reuse; steps run when inputs are filled |
| Provenance | `columns/cell.ts` | unchanged — value + confidence + source |

Orchestration (jobs, run-only-if-empty, provenance) is already right. Dogi adds a
**config + provider + web-search + column-creation + planner** layer on top.

---

## 11. Worked examples

1. **Find CEO email** — cell Dogi, `output: create ceo_email`, `webSearch:
   native`. → research loop, email + source + confidence.
2. **Summarize two columns (aggregate)** — cell Dogi, reads `[funding, hiring]`,
   `output: create signal_summary`, `webSearch: off`. → one transform call, cheap.
3. **Find CEO email → write a custom email (goal mode)** — Ask Dogi the goal; it
   plans two columns (`ceo_email` web-on, then `custom_email` web-off reading
   `ceo_email`), you approve, it creates + runs them in order.
4. **Map to existing** — same as #3 but step 2's output is **mapped** to your
   existing `outreach_email` column instead of creating a new one.
5. **ICP score** — cell Dogi, reads `[company_size, industry, signal_summary]`,
   `output: create icp_score`, `webSearch: off`, "score 0–100 fit for our ICP".
