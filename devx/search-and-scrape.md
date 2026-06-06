# Search & Scrape — self-hosted, open-source, configurable

> Status: **PLANNING** — agreed direction, not yet built. This is the architecture
> for giving Dogi real web data *without* depending on a paid API, in keeping with
> "open-source, self-hostable Clay."

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

## 3. Backend selection (configurable, with graceful fallback)

**Web search** (`webSearch.ts`) picks a backend at call time:
1. `OPENSERP_URL` set → **OpenSERP** (`GET {OPENSERP_URL}/google/search?text=…&lang=EN&limit=N` → `[{url,title,description}]`).
2. else `SERPER_API_KEY` set → Serper (kept for hosted users).
3. else → "web_search unavailable" (the loop still runs with fewer tools, as today).

**Scrape** (`scrapeUrl.ts`):
1. `FIRECRAWL_API_URL` set → **self-hosted Firecrawl** (`POST {FIRECRAWL_API_URL}/v1/scrape`, no key, or key optional).
2. else `FIRECRAWL_API_KEY` set → hosted Firecrawl.
3. else → "scrape_url unavailable".

This keeps **BYO-hosted and BYO-cloud both working**, and the precedence means a
self-host setup (just set the two URLs) needs no API keys.

## 4. Per-Dogi enable/disable (already partly there)

- The per-Dogi **sources** already toggle web-search and scrape on/off
  (`DogiConfigForm`). Those toggles stay the user-facing switch.
- **Availability** is surfaced from `GET /settings` (extend it): report
  `openserp` and `firecrawl_selfhosted` as configured/not, so the UI can show
  "web search: self-hosted (OpenSERP)" vs "not configured" and disable the toggle
  with a hint when the backend isn't running.
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

## 8. Build steps (when we start)

1. `webSearch.ts`: add the OpenSERP backend + env precedence; normalize results to
   the existing shape. Unit-test backend selection.
2. `scrapeUrl.ts`: add `FIRECRAWL_API_URL` (self-hosted) precedence.
3. `GET /settings`: report `openserp` / `firecrawl_selfhosted` availability; UI
   shows it and gates the toggles.
4. Compose/`docs`: an opt-in `search` profile + a README section; `.env.example`
   gains the four vars above.
5. Verify live: run OpenSERP + Firecrawl locally, point a Dogi at web+scrape, and
   confirm a LinkedIn/CEO cell fills *with a real source URL*.

Related: [dogi-agent.md](./dogi-agent.md) (the research loop + sources),
[providers-and-keys.md](./providers-and-keys.md), [doggo.md](./doggo.md).
