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

**Enrichment is what Dogi does.** The old `enrichment` and `agent` column types
merge into one `dogi` type — *enriching a cell* = sending Dogi to fetch its
value. (`formula` and `manual` stay separate; they don't fetch.)

---

## 2. Anatomy (the simple cell config)

The default config is **deliberately tiny** — five things:

| Field | Meaning | Example |
|---|---|---|
| `instruction` | Plain-language task | "Find this company's CEO's email" |
| `reads` | Input columns Dogi can see | `["company", "domain"]` |
| `output` | Where the value goes (create or map — see §5) | new column `ceo_email` |
| `sources` | Where Dogi may look — any of: data provider · web search · scrape · LLM. **All optional** (see §4) | `[web search, llm]` |
| `policy` | How enabled sources combine: **combine** (default) or **stop at first** (see §4) | `combine` |
| `brain` | The LLM (provider/model + key). **Optional** — a providers-only Dogi needs none | `{ anthropic, claude-opus-4-8 }` |

```
┌──────────────────────────── Dogi (a column) ───────────────────────────┐
│  instruction:  "Find the CEO's email"                                   │
│  reads:        company, domain                                          │
│  output:       ◉ new column "ceo_email"   ○ map to existing ▼          │
│  sources:      ☑ data provider  ☑ web search  ☐ scrape  ☑ LLM           │
│  combine:      ◉ use all & combine   ○ stop at first answer             │
│  brain:        Anthropic · claude-opus-4-8   key: env ▼   (if LLM used) │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. How Dogi runs (execution)

Two execution shapes, chosen automatically by whether tools are on:

### a) Transform (LLM only, no external sources) — one call
Pure LLM over the `reads` columns. Covers the **"aggregate/summarize two
columns"** case and the **"write an email from found fields"** case. Fast, cheap,
no network. **One LLM call** (`maxSteps = 1`).

### b) Research loop (sources on) — tool-calling
The model proposes a search/scrape, we run it, feed results back, loop until a
confident value or the **step ceiling** (`maxSteps`, default 6). This is our
existing `packages/agent` loop, generalized.

> **Two execution shapes ⇒ two system prompts.** This distinction is not just
> about tools — it changes what we *ask the model to do*, so each shape gets its
> own system prompt (`packages/agent/src/dogi.ts`):
>
> | Shape | Prompt | Posture |
> |---|---|---|
> | **Research** (tools / native search on) | `SYSTEM_RESEARCH` | *"Find ONE field… **Never guess.** If you cannot find it, return value null."* A wrong fact is worse than no fact. |
> | **Transform** (LLM only) | `SYSTEM_TRANSFORM` | *"Produce ONE field by transforming the given context (summarize / classify / rewrite / derive). Don't invent external facts; return null only when the context genuinely lacks what you need."* |
>
> The selector is one line: `isResearch = Boolean(opts.tools?.length || opts.webSearch)`.
> **Why it matters:** a single research prompt makes transform columns *refuse*
> ("never guess" ⇒ `value: null` ⇒ cell shows failed) even though generation was
> the whole point. See §12.

```
reads + instruction
        │
        ▼
   ┌────────── if a web/scrape source is on ────┐
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

## 4. Sources — where Dogi may look (all optional, fully configurable)

A Dogi can use any mix of these, and the user can turn each on/off anytime:

| Source | What it is | Needs LLM? |
|---|---|---|
| **Data provider** | a structured lookup (Apollo / ZoomInfo / RocketReach…) | No |
| **Web search** | two options — **native** (the LLM provider's own web search) or **external** (our search, e.g. Serper) | Yes |
| **Scrape** | our `firecrawl` — read a specific page | Yes |
| **LLM** | reason / transform / extract | (is the LLM) |

So the same Dogi covers every persona: **providers only** (no LLM at all),
**LLM + web search only**, or **everything layered** — your choice.

**How enabled sources combine** — one setting:
- **Combine (default)** — use *all* the enabled sources and merge what they
  return (richest data; pays for each). This is the default.
- **Stop at first answer** — try sources in order and **stop** the moment one
  returns a confident value (cheapest; skips the rest). "Confident" = the value's
  confidence is high enough to trust; a shaky guess moves to the next source.

It's a per-Dogi toggle either way — nothing is forced.

> **Data providers — now vs later.** For now a Dogi uses **one data provider at
> a time** (e.g. Apollo *or* ZoomInfo *or* RocketReach). Later we'll allow
> **multiple, ranked** into a waterfall the user orders, e.g.
> `1. Apollo → 2. ZoomInfo → 3. RocketReach → 4. LLM → 5. web search`.

Web-search / scrape keys: see [providers-and-keys.md](./providers-and-keys.md).

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
  `instruction / reads / output / sources`, and **dependencies** (step 2 reads
  step 1's output column).
- You **review** the plan — rename columns, switch any output to *map-to-existing*,
  toggle sources, change the model, or drop a step.
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
  "sources": [                       // all optional; ordered; one data provider for now
    { "type": "provider", "name": "apollo" },
    { "type": "web", "via": "native" },   // native | external  (external = our Serper)
    { "type": "scrape", "via": "firecrawl" },
    { "type": "llm" }
  ],
  "policy": "combine",               // combine (default) | first   ("stop at first answer")
  "brain": { "provider": "anthropic", "model": "claude-opus-4-8", "keySource": "env" },
                                     // brain optional — omit for a providers-only Dogi
  "maxSteps": 6
}

// A saved goal-plan (Dogi builds these columns, in order)
{
  "kind": "dogi-plan",
  "goal": "find CEO email then write a custom email",
  "steps": [
    { "id": "s1", "instruction": "Find the CEO's email.",
      "reads": ["company","domain"], "output": { "mode": "create", "key": "ceo_email" },
      "sources": [{ "type": "provider", "name": "apollo" }, { "type": "web", "via": "native" }],
      "policy": "combine", "dependsOn": [] },
    { "id": "s2", "instruction": "Write a short custom cold email to the CEO.",
      "reads": ["ceo_email","company","first_name"],
      "output": { "mode": "create", "key": "custom_email" },
      "sources": [{ "type": "llm" }], "dependsOn": ["s1"] }
  ],
  "flow": null                       // null = linear plan; object = advanced graph
}
```

---

## 10. How this maps to existing code

We **extend**, not rewrite:

| Need | Today | Change |
|---|---|---|
| The loop | `packages/agent/src/loop.ts` | accept `reads/output/sources/policy/brain`; transform vs loop |
| Sources | `packages/agent/src/tools/` (serper, firecrawl) | add **data providers** (one at a time now) + **native** web search; all optional |
| LLM client | `packages/llm` (anthropic, openai) | add **gemini, grok**; native-search capability; **BYOK** key arg |
| Column types | `packages/columns` (4 types) | unify enrichment+agent → **`dogi`**; keep formula/manual |
| **Create columns** | columns CRUD exists (`POST /columns`) | let a Dogi run **create a column** (preview+confirm, audit) |
| **Goal plan** | — | a **planner** (LLM) that emits the `dogi-plan`; run steps in dep order |
| Save/reuse | `prompts` table | add **`agents`** table (saved Dogis + plans) |
| Run on rows | `columns/engine.ts` (fan-out, run-only-if-empty) | reuse; steps run when inputs are filled |
| Provenance | `columns/cell.ts` | unchanged — value + confidence + source |

Orchestration (jobs, run-only-if-empty, provenance) is already right. Dogi adds a
**configurable sources + column-creation + planner** layer on top.

---

## 11. Worked examples

1. **Find CEO email (providers only)** — `sources: [provider apollo]`, no brain.
   → structured lookup, no LLM call, email + source + confidence.
2. **Find CEO email (layered)** — `sources: [provider apollo, web native, llm]`,
   `policy: combine`. → providers + web + LLM all enrich it.
3. **Summarize two columns (aggregate)** — reads `[funding, hiring]`,
   `output: create signal_summary`, `sources: [llm]`. → one transform call, cheap.
4. **Find CEO email → write a custom email (goal mode)** — Ask Dogi the goal; it
   plans two columns (`ceo_email` then `custom_email` reading `ceo_email`), you
   approve, it creates + runs them in order.
5. **Map to existing** — same as #4 but step 2's output is **mapped** to your
   existing `outreach_email` column instead of creating a new one.

---

## 12. Verified live (2026-06-06)

Dogi was run end-to-end against a real OpenAI key (`gpt-4o-mini`) — not mocks —
through the full **API → pg-boss → worker → Postgres** path. The trace below is
the actual pipeline; every hop was confirmed:

```
 column config (sources:[llm], brain:openai/gpt-4o-mini)
        │  POST /tables/:id/columns/:key/run  { force:true }
        ▼
 planRun ──► enqueue('enrich', {leadId, columnKey})        ← API only writes+enqueues
        ▼
 worker: runner.ts ──► runDogi(config, ctx)
        │                 ├─ resolveBrain  → getLLM({provider,model,key})   ✅ valid client
        │                 ├─ runSource('llm') → runLLMSource (maxSteps=1)
        │                 │     ├─ system = SYSTEM_TRANSFORM   ← the fix
        │                 │     └─ llm.chat() → {"value":…,"confidence":…}   ✅ JSON
        │                 └─ parseResult → mergeResults
        ▼
 write leads.data[key] + enrichmentConf[key]  ·  status = done   ✅ cell filled
```

**What we tested and saw:**

| Test (live, real key) | Result |
|---|---|
| `getLLM` + `llm.chat()` | ✅ valid client, well-formed JSON |
| Deterministic transform ("company → UPPERCASE") | ✅ `"ACME"`, confidence 1.0 |
| Generative transform ("describe this company") | ✅ real one-liner, confidence 0.9 |
| Full run on the example table (Initech / Acme / Globex) | ✅ all three cells filled |
| Agent unit tests + typecheck | ✅ 6/6 pass, clean |

**The bug we found (and fixed).** Live testing surfaced what mocked unit tests
could not: every **LLM-only** cell came back `failed` with an empty value, while
the pipeline itself was provably healthy (key works, client builds, `chat()`
returns proper JSON). Root cause: Dogi used **one** research-oriented system
prompt for *all* shapes. Its instruction *"Never guess… return value null if you
cannot find it"* is correct for web/scrape but tells a pure-transform column to
**refuse** — so "summarize/describe/derive" tasks returned `null`. Fix: split the
prompt by execution shape (§3). `null → failed` provenance is otherwise correct —
e.g. a row with no company legitimately yields no description.

> **Determinism note.** A borderline input (a fictional name with no other
> context) can still return `null` on one run and a value on the next — that's the
> model's call under "don't invent external facts," not a pipeline fault. Re-run
> or add more `reads` context.

---

## 13. How to modify Dogi — in points

All of this lives in `packages/agent/src/dogi.ts` unless noted.

- **Change a mode's behaviour / tone** → edit `SYSTEM_RESEARCH` or
  `SYSTEM_TRANSFORM`. Keep the JSON output contract (`OUTPUT_CONTRACT`) intact —
  `parseResult` depends on it.
- **Change the output contract** (add a field to every cell) → edit
  `OUTPUT_CONTRACT` **and** `parseResult` together; update `DogiResult` type.
- **Change when a run is "research" vs "transform"** → the selector
  `isResearch = Boolean(opts.tools?.length || opts.webSearch)` in `runLLMSource`.
- **Add a new source type** (e.g. a second provider, a vector lookup) → add a
  `case` in `runSource`, give it a `providerTag`, and extend the `DogiSource`
  union in `packages/core` (the config schema).
- **Change the step ceiling for research loops** → `config.maxSteps` (default 6);
  transform is always 1 call.
- **Change the "stop at first confident answer" threshold** → `CONFIDENCE_FLOOR`
  (0.5) used by the `first` policy.
- **Change how multiple sources merge** → `mergeResults` (the `combine` policy)
  and the `policy` switch in `runDogi`.
- **Change which lead columns the model sees** → `leadContext` (it surfaces the
  base identity + only the `reads` keys — the allow-list).
- **Swap / add an LLM provider or model** → `packages/llm` (`getLLM`,
  `DEFAULT_MODELS`); native web search is `ChatOptions.webSearch:'native'`.
- **Use a caller's own key (BYOK)** → pass `apiKey` through the run context;
  `resolveBrain` honours `brain.keySource:'byok'`. Keys are never persisted/logged.
- **Always test changes live**, not only with mocked unit tests — the prompt bug
  above was invisible to mocks. Quick harness: a throwaway `src/_dbg.ts` that
  imports `runDogi` and runs it with a real key (delete after).
