# Providers, web search, and keys

How Dogi's brain is configured: which LLM providers we support, the two
web-search backends, and how keys flow (BYOK **and** env).

---

## 1. Four providers from the start

| Provider | Example models | Native web search tool |
|---|---|---|
| **Anthropic** | claude-opus-4-8, sonnet, haiku | `web_search_20250305` |
| **OpenAI** | gpt-5.x / 4.1 family | `web_search` (Responses API) |
| **Gemini** (Google) | gemini-2.5/3.x flash & pro | `googleSearch` grounding |
| **Grok** (xAI) | grok-4.x | `web_search` (Responses API) |

Vertex (Gemini via GCP service account) is **optional, later** — OpenClay has it
and we can lift it when someone needs enterprise GCP.

We extend `packages/llm`:
- add `GeminiClient` and `GrokClient` next to the existing Anthropic/OpenAI ones,
- give `LLMClient.chat()` a `webSearch?: 'native'` capability that attaches the
  provider's own search tool,
- accept a **per-call API key** (for BYOK) instead of only the env key.

OpenClay's `app/api/enrich/route.ts` is a clean reference for each provider's
request shape (and shows the native-search tool payloads). See the license note
below before copying literal code.

---

## 2. Web/scrape backends

These are the web/scrape **sources** a Dogi can enable (alongside data providers
and LLM — see [dogi-agent.md §4](./dogi-agent.md)):

| Backend | What | Keys needed |
|---|---|---|
| `native` | the **provider's own** web search | LLM key only |
| `serper` | **our** Serper (Google) search tool | `SERPER_API_KEY` |
| `firecrawl` | **our** Firecrawl scrape/extract tool | `FIRECRAWL_API_KEY` |

`native` needs zero extra setup. `serper`/`firecrawl` already exist in
`packages/agent/src/tools/`; we just expose them as a user choice and let advanced
flows chain them. This gives the user the toggle OpenClay has **plus** the option
to use our own search budget/tools.

---

## 3. Keys: BYOK and env, both

Two ways to supply a key, both supported:

- **Env (server-side)** — keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `GROK_API_KEY`, `SERPER_API_KEY`, `FIRECRAWL_API_KEY`). Best
  for a single-operator self-host. The default `keySource: "env"`.
- **BYOK (in the UI)** — a user pastes their key; it's used for that run and
  **never persisted server-side** (kept in the request / session only, like
  OpenClay). `keySource: "byok"`. Good for shared instances where each user pays
  for their own usage.

Resolution per run: if the Dogi's `keySource` is `byok`, the key rides on the run
request; otherwise the worker reads the env key for that provider. **Never log
keys; never write a BYOK key to the DB.**

### Security rules (non-negotiable)
- BYOK keys: request/session memory only — not DB, not logs, not audit.
- Env keys: server-side only, never sent to the browser.
- Webhooks keep signature verification; public endpoints stay rate-limited.

---

## 4. Cost estimate + test-before-run (from OpenClay)

Two UX safeties worth porting:
- **Cost estimate** — using a `pricing` table (input/output per-1M, plus
  web-search per-1k) + token counting, show the estimated cost of running a
  column over N rows **before** firing. OpenClay's `lib/pricing.ts` +
  `lib/costEstimator.ts` are the reference.
- **Test 5 rows** — run a Dogi on a small sample first, eyeball the results,
  then run the full table. A "Test" button next to "Run column".

These map onto our job system cleanly (a test run = a 5-row fan-out).

---

## 5. License note (OpenClay reuse) {#license}

OpenClay (`/Users/ayush/dev/Altclay`) is public but currently ships **no LICENSE
file**. Under default copyright, "no license" means **all rights reserved** — being
on GitHub doesn't grant reuse rights. So:

- **Ideas / patterns / API shapes** — free to learn from and reimplement
  (facts and methods aren't copyright-protected).
- **Literal source copied verbatim** — get the author's OK (ask them to add an
  MIT/Apache license), or reimplement in our own words/structure.

Practically: we already have the structure (`packages/llm`, `packages/agent`), so
**reimplementing** each provider call from the reference is low-effort and keeps
us clean. Default to that unless the author licenses the repo.
