# Search & Scrape — self-hosted, open-source, configurable

> Status: **AS BUILT (v1)** — the two tool backends, the env config, and the
> `GET /settings` availability report are implemented and tested. What remains
> opt-in/infra (the compose `search` profile, `.env.example` rows, running
> Firecrawl locally) is owned by the infra agent / `devx/RUN-search-stack.md`.
> This doc is the architecture for giving Dogi real web data *without* depending
> on a paid API, in keeping with "open-source, self-hostable Clay."

## 1. Why

Dogi enrichment is unreliable for hard facts (a specific CEO's LinkedIn URL)
because today the only working search is the **LLM's own native web search**
(`gpt-4o-mini`), which fires but returns thin results, and there is **no fallback**
(Serper/Firecrawl have no keys). We want a **self-hostable** search+scrape stack:

- **OpenSERP** (https://github.com/karust/openserp) — a free, self-hosted HTTP
  service that returns real search results (Google/Yandex/Baidu/DuckDuckGo) by
  driving a headless browser. **No API key.**
- **Firecrawl** (https://github.com/firecrawl/firecrawl) — open-source; self-host
  it to turn a result URL into clean markdown the LLM can read.

Both are **optional and configurable** — a self-hoster runs them (or not), and
each Dogi can enable/disable web-search and scrape independently.

## 2. How it slots into what exists (no rewrite)

The agent already has the right shape — two pluggable tools behind two source types:

| Dogi source | Tool today | Calls today | Change |
|---|---|---|---|
| `{type:'web', via:'external'}` | `packages/agent/src/tools/webSearch.ts` | Serper (`SERPER_API_KEY`) | add an **OpenSERP backend**; pick by env |
| `{type:'scrape', via:'firecrawl'}` | `packages/agent/src/tools/scrapeUrl.ts` | hosted Firecrawl (`FIRECRAWL_API_KEY`) | allow a **self-hosted Firecrawl URL** |
| `{type:'web', via:'native'}` | the LLM provider's own search | (OpenAI Responses) | unchanged — stays as a cheap default |

So the **research loop is already built** (`runLLMSource` with tools, `maxSteps`):
the LLM calls `web_search` (→ OpenSERP) to get result URLs, then `scrape_url`
(→ Firecrawl) to read the best page, then returns `{value, confidence, source}`.
We are swapping the *backends* of those two tools, not the loop.

## 3. Backend selection (configurable, with graceful fallback) — **as built**

Both tools choose their backend from env **at call time** (no restart wiring,
no per-Dogi backend choice — that stays the env's job). The normalized output is
identical across backends, so the research loop never changes.

**Web search** (`packages/agent/src/tools/webSearch.ts`):
1. `OPENSERP_URL` set → **OpenSERP**:
   `GET {OPENSERP_URL}/{engine}/search?text=…&lang=EN&limit=5`, where
   `engine = OPENSERP_ENGINE || 'google'`. Parses the response's
   `results: [{ title, url, snippet }]` and **normalizes to the existing Serper
   shape** `[{ title, link, snippet }]` (url→link, snippet kept; description also
   accepted). On OpenSERP error JSON (e.g. `{error:'captcha_detected'}`) it
   returns a clear, **non-fatal** `web_search unavailable: …` message; on an
   unreachable host or zero results it returns a likewise-clear message.
2. else `SERPER_API_KEY` set → **Serper** (hosted Google; kept for cloud users).
3. else → `web_search unavailable: no search backend configured …`.

When both `OPENSERP_URL` and `SERPER_API_KEY` are set, **OpenSERP wins**.

**Scrape** (`packages/agent/src/tools/scrapeUrl.ts`):
1. `FIRECRAWL_API_URL` set → **self-hosted Firecrawl**:
   `POST {FIRECRAWL_API_URL}/v1/scrape` with `{url, formats:['markdown']}`. **No
   key required**; a `Bearer {FIRECRAWL_API_KEY}` header is added only if that
   key is *also* set (for a secured self-host). Parses the same `data.markdown`
   the hosted path uses (capped at 8000 chars).
2. else `FIRECRAWL_API_KEY` set → **hosted Firecrawl** (`api.firecrawl.dev`).
3. else → `scrape_url unavailable: no scrape backend configured …`.

When both are set, the **self-hosted URL wins**.

This keeps **BYO-hosted and BYO-cloud both working**, and the precedence means a
self-host setup (just set the two URLs) needs no API keys.

### OpenSERP engine config (`OPENSERP_ENGINE`)

OpenSERP drives a real browser against the chosen engine. `google` is the
**default** and best for residential IPs. On **datacenter IPs** (CI, cloud VMs)
Google frequently returns a CAPTCHA — the tool surfaces that as the non-fatal
`captcha_detected` message above. Set `OPENSERP_ENGINE=yandex` (or `duckduckgo`
/ `baidu`) to fall back to an engine that answers from such IPs. In this dev
environment `yandex` works and `google` is CAPTCHA-blocked, so local runs use
`OPENSERP_URL=http://localhost:7001 OPENSERP_ENGINE=yandex`.

## 4. Per-Dogi enable/disable (already partly there)

- The per-Dogi **sources** already toggle web-search and scrape on/off
  (`DogiConfigForm`). Those toggles stay the user-facing switch.
- **Availability** is surfaced from `GET /settings` (**as built**): a new
  `search` block reports presence-only booleans — `openserp`
  (`OPENSERP_URL` set), `serper` (`SERPER_API_KEY` set), `firecrawl_selfhosted`
  (`FIRECRAWL_API_URL` set), and `firecrawl` (`FIRECRAWL_API_KEY` set). The
  existing `keys` block is unchanged. The UI can show "web search: self-hosted
  (OpenSERP)" vs "not configured" and disable the per-Dogi toggle with a hint
  when the backend isn't running. Example:

  ```json
  "search": { "openserp": true, "serper": false,
              "firecrawl_selfhosted": false, "firecrawl": false }
  ```
- A Dogi that enables web-search/scrape while the backend is down gets a clear,
  **non-fatal** tool message ("web_search unavailable…") — never a crash.

## 5. Running the services (self-host)

Add an **opt-in** profile to the dev/compose setup (NOT in the baseline boot):

- **OpenSERP** — `docker run -p 7000:7000 karust/openserp serve -a 0.0.0.0 -p 7000`
  → `OPENSERP_URL=http://localhost:7000`. Caveats: it scrapes Google with a real
  browser, so it can hit rate-limits/CAPTCHAs under heavy use; DuckDuckGo/Yandex
  engines are alternates. Tune `limit` and cache results.
- **Firecrawl (self-host)** — its repo ships a `docker-compose` (api + worker +
  redis + playwright). Run it, then `FIRECRAWL_API_URL=http://localhost:3002`.
  Footprint is non-trivial (a few services + a browser) — document it as an
  optional component, not a default.

`scripts/dev.sh` stays lean; the search stack is a separate `docker compose
--profile search up` (or documented `docker run`s) so the core product still
boots with just Postgres.

## 6. Config surface (env)

```
# Web search backend (pick one; OpenSERP preferred for self-host)
OPENSERP_URL=            # e.g. http://localhost:7000  → use OpenSERP
SERPER_API_KEY=          # hosted fallback

# Scrape backend
FIRECRAWL_API_URL=       # e.g. http://localhost:3002  → self-hosted Firecrawl
FIRECRAWL_API_KEY=       # hosted fallback (or auth for a secured self-host)
```

## 7. What this fixes (and what it doesn't)

- **Fixes:** real, citable web results + page scraping for hard facts (CEO,
  LinkedIn) — the research loop can actually find and read sources, with the URL
  captured as provenance. Fully self-hostable, no paid keys.
- **Doesn't fix on its own:** the LLM still has to *reason over* the results, so a
  weak model still under-performs — but with real search + scrape feeding it, even
  a small model does far better than "native search on mini." Model choice stays a
  separate, per-Dogi `brain` decision.
- **LinkedIn specifically:** LinkedIn blocks scrapers, so the reliable path is
  *search → get the profile URL from the result link itself* (OpenSERP returns the
  `linkedin.com/in/...` URL in the result), not scraping the page. The tool should
  prefer returning the result URL for "find the LinkedIn" tasks.

## 8. Build steps — status

1. ~~`webSearch.ts`: add the OpenSERP backend + env precedence; normalize results
   to the existing shape. Unit-test backend selection.~~ **Done.**
2. ~~`scrapeUrl.ts`: add `FIRECRAWL_API_URL` (self-hosted) precedence.~~ **Done.**
3. ~~`GET /settings`: report `openserp` / `firecrawl_selfhosted` availability~~
   **Done** (the `search` block above); the UI gating is the frontend agent's.
4. **Infra (not this agent):** an opt-in compose `search` profile + a README
   section; `.env.example` gains `OPENSERP_URL`, `OPENSERP_ENGINE`,
   `FIRECRAWL_API_URL`, `FIRECRAWL_API_KEY`, `SERPER_API_KEY`. See
   `devx/RUN-search-stack.md`.
5. **Verified live:** with `OPENSERP_URL=http://localhost:7001
   OPENSERP_ENGINE=yandex`, `web_search` for "Hero MotoCorp CEO LinkedIn"
   returns real `linkedin.com/in/...` URLs and the current-CEO news in the
   normalized `[{title,link,snippet}]` shape. Pointing a full Dogi at web+scrape
   for a CEO/LinkedIn cell is the remaining end-to-end check.

The new env vars live in the zod schema at `packages/core/src/env.ts`
(`OPENSERP_URL`, `OPENSERP_ENGINE`, `FIRECRAWL_API_URL` added alongside the
existing `SERPER_API_KEY` / `FIRECRAWL_API_KEY`).

## 9. The full pipeline, end to end (chart)

How one Dogi cell gets filled from real web data. The API only enqueues; the
**worker** runs the research loop; OpenSERP + Firecrawl are separate self-hosted
services; every value lands back with provenance.

```
  USER / BONE                      API (Hono)                 QUEUE (pg-boss, in Postgres)
  ───────────                      ──────────                 ────────────────────────────
  run column / cell  ───────────►  POST .../run  ──enqueue──►  job: { leadId, columnKey }
  (sources: web:external,                                            │
           scrape, llm)                                              ▼
                                                            WORKER  enrich handler
                                                            ────────────────────────
                                                            1. load lead + column.config
                                                            2. run-only-if-empty guard
                                                            3. runDogi(config, lead)
                                                                     │
        ┌────────────────────────── runDogi · per source (policy: combine | first) ──────────────────────────┐
        │                                                                                                     │
        │   leadContext(lead)  +  instruction                                                                 │
        │        │                                                                                            │
        │        ▼                                                                                            │
        │   ┌─────────────────────────── runLLMSource : the RESEARCH LOOP (≤ maxSteps) ────────────────────┐ │
        │   │                                                                                               │ │
        │   │   LLM.chat(messages, tools=[web_search, scrape_url])                                          │ │
        │   │        │                                                                                      │ │
        │   │        ├─ model emits tool_call: web_search("Hero MotoCorp CEO")                              │ │
        │   │        │        │                                                                             │ │
        │   │        │        ▼                                                                             │ │
        │   │        │   webSearch.ts ──HTTP──►  OPENSERP  (self-hosted :7001)  ──►  [{title,link,snippet}] │ │
        │   │        │        │                  (engine: google | yandex | …)                              │ │
        │   │        │        ▼                                                                             │ │
        │   │        │   push assistant{tool_calls} + tool{result}  ◄── THE FIX (see §10)                   │ │
        │   │        │                                                                                      │ │
        │   │        ├─ model emits tool_call: scrape_url("https://…moneycontrol…")                         │ │
        │   │        │        │                                                                             │ │
        │   │        │        ▼                                                                             │ │
        │   │        │   scrapeUrl.ts ──HTTP──►  FIRECRAWL  (self-hosted :3002)  ──►  clean markdown         │ │
        │   │        │        │                                                                             │ │
        │   │        │        ▼                                                                             │ │
        │   │        │   push assistant{tool_calls} + tool{markdown}                                        │ │
        │   │        │                                                                                      │ │
        │   │        └─ model returns FINAL: { "value":"Harshavardhan Chitale",                             │ │
        │   │                                  "confidence":0.9, "source":"https://…moneycontrol…" }        │ │
        │   └───────────────────────────────────────────────────────────────────────────────────────────┘ │
        │                                                                                                     │
        └──────────────────────────────── mergeResults (combine) / first-confident ───────────────────────────┘
                                                            │
                                                            ▼
                                            writeCell:  data[col] = value
                                                        enrichmentConf[col] = { status:'filled',
                                                                                confidence, source, provider }
                                            (miss → writeCellFailure: status:'failed', error)   ← §R2 visibility
```

Key properties: **async** (API never blocks — the worker does the slow loop);
**bounded** (`maxSteps`, default 6); **graceful** (a missing/`captcha`'d backend
returns a non-fatal tool message, the loop continues); **provenance on every
cell** (value + confidence + the **source URL** the model actually used); and the
backends are **swappable by env** (OpenSERP↔Serper, self-hosted↔hosted Firecrawl)
with the normalized tool output identical, so the loop never changes.

## 10. Why enrichment wasn't working earlier (the bugs, in detail)

Four independent problems stacked up; live testing (not unit tests) surfaced each.

1. **The research loop never completed on OpenAI — the big one.** The multi-step
   tool loop replayed the assistant turn that *made* the tool calls **without** its
   `tool_calls`, so the follow-up `tool` result message was orphaned and OpenAI
   rejected the whole request:
   > `400 — messages with role 'tool' must be a response to a preceding message with 'tool_calls'.`
   - **Root cause:** `LLMMessage` had no field to carry an assistant's tool calls;
     `dogi.ts` pushed `{role:'assistant', content}` (calls dropped); `openai.ts`
     serialized assistant messages as `{role, content}` only.
   - **Effect:** *any* Dogi using `web:external` + `scrape` (the function-calling
     loop) failed every time — so OpenSERP/Firecrawl could never fill a cell.
     (Cells that *did* fill used `web:native` or pure `llm`, which don't use the
     loop — masking the bug.)
   - **Fix:** `LLMMessage.toolCalls?`; `dogi.ts` replays the assistant message
     **with** `res.toolCalls`; each provider serializes the replay in its own
     shape — OpenAI/Grok `tool_calls[]` + `tool_call_id`, Anthropic
     `tool_use`/`tool_result`, Gemini `functionCall`/`functionResponse` —
     covered by `packages/llm/test/toolReplay.test.ts`.
   - **Verified live after the fix:** "Hero MotoCorp" → CEO **Harshavardhan
     Chitale** with a real **moneycontrol.com** source, provider
     `web:external+scrape`, no 400.

2. **The research prompt made pure-LLM columns refuse.** One system prompt
   (*"Never guess… return null if not found"*) is right for research but tells a
   *transform* column (summarize/derive) to return `null`. Split into
   `SYSTEM_RESEARCH` (tools on) vs `SYSTEM_TRANSFORM` (LLM-only). (See
   `dogi-agent.md` §12.)

3. **Weak model + no fallback.** Columns had no `brain`, so they fell back to
   `gpt-4o-mini`'s native search — it fires but returns thin results, and there was
   **no external search / scrape** behind it (Serper/Firecrawl unkeyed). This whole
   doc (OpenSERP + self-hosted Firecrawl) is the fallback. Model quality stays a
   per-Dogi `brain` choice.

4. **No anchor → garbage answer.** A row with no reference data (e.g. a `company`
   that was silently dropped by the fixed-schema quick-add path) gives the model
   nothing to look up, so it free-associates ("Fetch" → the wrong CEO). The fix is
   the **arbitrary-columns** rework (any field is stored + surfaced to Dogi) — see
   [multi-table.md](./multi-table.md) / the data-model plan. Separately,
   **per-cell failure visibility** (§R2) now shows a ⚠ + reason + re-run so a miss
   is never silent.

**Net:** the search/scrape backends were wired correctly, but the *loop* (1) and
the *anchor* (4) were the real blockers. Both are fixed; (3) is mitigated by this
stack; (4)'s data-model rework is the next build.

Related: [dogi-agent.md](./dogi-agent.md) (the research loop + sources),
[providers-and-keys.md](./providers-and-keys.md), [bone.md](./bone.md),
[RUN-search-stack.md](./RUN-search-stack.md) (how to run the services).
