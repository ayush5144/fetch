# Dogi — the fetch agent 🐕

**Fetch** is a dog that **fetches**. **Dogi** is the agent you send to fill a
cell. This doc is the working spec for Dogi: what it is, how it runs, how a user
customizes it (simple and advanced), and how it maps onto the code we already
have.

---

## 1. Mental model

> **A column is a saved Dogi. Running a column sends that Dogi across every row.**

When an operator adds an enrichment/agent column, they're really configuring a
small agent: *what it reads, what it writes, whether it may search the web, which
brain (model) it uses, and the instruction.* That configuration is the column.
Fire it on a row and Dogi goes and fetches the value.

This is the same idea Clay calls "a column is a definition of how a value gets
filled" — we just make the agent first-class, nameable, and reusable.

---

## 2. Anatomy (the simple config)

The default config is **deliberately tiny** — five things:

| Field | Meaning | Example |
|---|---|---|
| `instruction` | Plain-language task | "Find this company's CEO's email" |
| `reads` | Input columns Dogi can see (context) | `["company", "domain"]` |
| `writes` | Output column(s) it fills | `["ceo_email"]` |
| `webSearch` | `off` \| `native` \| `serper` \| `firecrawl` | `native` |
| `brain` | `{ provider, model }` (+ optional BYOK key ref) | `{ anthropic, claude-opus-4-8 }` |

That's the whole simple form. Everything else has a sensible default.

```
┌──────────────────────────── Dogi (a column) ───────────────────────────┐
│  instruction:  "Find the CEO's email"                                   │
│  reads:        company, domain          writes:  ceo_email              │
│  web search:   ◉ native  ○ off  ○ serper  ○ firecrawl                    │
│  brain:        Anthropic · claude-opus-4-8        key: env ▼            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. How Dogi runs (execution)

Dogi has two execution shapes, chosen automatically by whether tools are on:

### a) Transform (web search **off**) — one call, no tools
Pure LLM over the `reads` columns. This covers your **"aggregate that summarizes
two columns"**: reads `[funding_summary, hiring_summary]`, writes `signal`, web
off → a single structured call, no network research, near-zero cost. Fast and
cheap.

### b) Research loop (web search **on**) — tool-calling
The agent loops: the model proposes a search/scrape, we run it, feed results
back, repeat until it returns a confident value or hits the **step ceiling**.
This is our existing `packages/agent` loop, generalized.

```
reads + instruction
        │
        ▼
   ┌──────────────── if webSearch != off ───────────────┐
   │  LLM ──proposes──► [ search ] / [ scrape ]          │
   │   ▲                      │ results                  │
   │   └──────────────────────┘  (loop ≤ maxSteps)       │
   └─────────────────────────────────────────────────────┘
        │
        ▼
   structured output  { value, confidence, source }
        │
        ▼
   write to cell  +  provenance (which URL, how sure)
```

**Output is always structured** — never prose. Dogi writes the value into
`leads.data[writes]` and the `{ confidence, source, provider }` into
`enrichmentConf[writes]`, exactly as the engine does today. The cell shows the
value with a confidence dot and a clickable source.

---

## 4. Web search — two backends, user's choice

A core customization (mirrors OpenClay's `useWebSearch`, but richer):

| `webSearch` | What runs | Needs | When to use |
|---|---|---|---|
| `off` | No tools — pure transform | nothing | summaries, formatting, aggregates over other cells |
| `native` | The **provider's own** web search tool (Anthropic `web_search`, Gemini `googleSearch`, OpenAI/Grok `web_search`) | just the LLM key | simplest "go look it up" — one toggle, no extra keys |
| `serper` | **Our** tool: Serper (Google) search → model reads results | `SERPER_API_KEY` | when you want control / your own search budget |
| `firecrawl` | **Our** tool: Firecrawl scrape/extract of a chosen page | `FIRECRAWL_API_KEY` | reading a specific site/page deeply |

`native` is the default because it needs no extra keys. `serper`/`firecrawl` are
our existing tools (`packages/agent/src/tools/`) exposed as a choice. A Dogi can
also combine them in advanced mode (search with Serper, then scrape with
Firecrawl).

---

## 5. Saved Dogis (reusable agents)

Like prompts today, a Dogi can be **named and saved**, then reused across columns
and tables.

- **Save**: "Save as agent" on any configured column → stored in a `agents`
  table (name, config, owner).
- **Reuse**: when adding a column, "Use a saved agent" lists them; pick one and
  it pre-fills the config (still editable per column).
- **Saved enrichments**: a saved Dogi *is* a saved enrichment. We also keep
  saving **prompts** (the instruction text) independently for personalization.

This gives a small library: a user builds "Find CEO email", "Summarize signals",
"ICP score", once — and drops them onto any table.

---

## 6. Simple vs Advanced customization

### Simple (default) — the 5-field form above
Covers ~90% of cases. One instruction, reads/writes, a web-search toggle, a
brain. No flowcharts, no wiring.

### Advanced — a Typebot / n8n-style visual flow
For power users who want to *map* a multi-step agent: a canvas where **nodes are
steps** and **edges connect fields**. You wire the dots: which column feeds which
step, what each step outputs, where the final value goes.

```
[ reads: company,domain ]
        │
        ▼
   ┌─────────────┐      ┌──────────────┐      ┌───────────────┐
   │  Search     │─────►│  Scrape top  │─────►│  Extract      │──► writes: ceo_email
   │ (Serper)    │ urls │  result      │ text │ "ceo email"   │
   └─────────────┘      └──────────────┘      └───────────────┘
        │ no result
        ▼
   ┌─────────────┐
   │  Native     │──► writes: ceo_email (fallback)
   │  web search │
   └─────────────┘
```

Node palette (v1 of advanced): **Input (column)**, **Web search**, **Scrape
URL**, **LLM step** (prompt + model), **Formula/transform**, **Output (column)**,
**Branch** (if/else on a value). The flow **compiles to the same execution plan**
the simple form produces — advanced is just a richer way to author the same
`config`. Simple configs can "open in flow editor" to graduate to advanced.

> Advanced is a **stretch** feature (Phase E). The simple form ships first; the
> flow editor is additive and authors the same underlying config.

---

## 7. Config schema (what gets stored)

A Dogi config lives in `columns.config` (or `agents.config` when saved). Sketch:

```jsonc
{
  "kind": "dogi",                  // distinguishes from formula/manual
  "instruction": "Find the CEO's email for this company.",
  "reads": ["company", "domain"],
  "writes": ["ceo_email"],
  "webSearch": "native",           // off | native | serper | firecrawl
  "brain": {
    "provider": "anthropic",       // anthropic | openai | gemini | grok
    "model": "claude-opus-4-8",
    "keySource": "env"             // env | byok  (byok → key passed per run, never stored)
  },
  "maxSteps": 6,                    // ceiling for the research loop
  "flow": null                     // null = simple; object = advanced graph
}
```

When `flow` is set, the engine executes the graph; otherwise it runs the simple
transform/loop from the fields above.

---

## 8. How this maps to existing code

We are **extending**, not rewriting:

| Need | Today | Change |
|---|---|---|
| The loop | `packages/agent/src/loop.ts` | accept `reads/writes/webSearch/brain`; pick transform vs loop |
| Tools | `packages/agent/src/tools/` (serper, firecrawl) | add **native web search** path per provider; keep ours as options |
| LLM client | `packages/llm` (anthropic, openai) | add **gemini, grok**; add `webSearch` capability + BYOK key arg |
| Column types | `packages/columns` (`enrichment/agent/formula/manual`) | unify `enrichment`+`agent` under **`dogi`**; keep `formula`/`manual` |
| Save/reuse | `prompts` table | add **`agents`** table (saved Dogis) |
| Run on rows | `columns/engine.ts` (run-only-if-empty, fan-out) | unchanged — still one job per row |
| Provenance | `columns/cell.ts` (`writeCell`) | unchanged — value + confidence + source |

The orchestration (jobs, run-only-if-empty, provenance, the table) is already
right. Dogi is mostly a **config + provider + web-search-choice** layer on top.

---

## 9. Worked examples

1. **Find CEO email** — `reads: [company, domain]`, `writes: [ceo_email]`,
   `webSearch: native`, brain GPT or Claude. → research loop, returns the email
   + the source URL + confidence.
2. **Summarize two columns (your aggregate)** — `reads: [funding_news,
   hiring_news]`, `writes: [signal_summary]`, `webSearch: off`. → one transform
   call, no search, cheap.
3. **ICP score from signals** — `reads: [company_size, industry, signal_summary]`,
   `writes: [icp_score]`, `webSearch: off`, instruction "score 0–100 fit for our
   ICP". → transform call returning a number + a one-line rationale as source.
4. **Deep read of a site** — advanced flow: Serper search → Firecrawl scrape the
   careers page → LLM extract "is hiring engineers" → write boolean.
