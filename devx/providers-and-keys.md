# Providers, web search, and keys

How Dogi's brain is configured: which LLM providers we support, the two
web-search backends, and how keys flow (BYOK **and** env).

> **Default brain:** the OpenAI default is now **`gpt-4o-mini-search-preview`** —
> a search-capable model, so Dogi/Bone get real, cited web results out of the
> box. It stays fully overridable (per-Dogi brain picker / env `LLM_MODEL`). See
> [§1b](#default-search).

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

## 1b. The default brain is search-capable (built-in web search) {#default-search}

**The OpenAI default is now `gpt-4o-mini-search-preview`** (set in
`DEFAULT_MODELS`, `packages/llm/src/index.ts`, and `.env.example`'s
`LLM_MODEL`). This is a deliberate change from the old `gpt-4o-mini`, which can
only answer from **training recall** — for a current fact ("the current CEO of
Hero MotoCorp") it replied *"I cannot provide real-time information… my training
cut-off is October 2023."* The search-preview model, by contrast, has **web
search built into Chat Completions** and returns a correct, **cited** answer out
of the box. Verified live (2026-06-06):

> *"As of June 2026, Harshavardhan Chitale is the Chief Executive Officer of Hero
> MotoCorp, having assumed the role on January 5, 2026."* — with a
> `heromotocorp.com` press-release source URL, returned through
> `getLLM({provider:'openai'})` with the env default.

**What "built-in web search" means.** A `*-search-preview` model
(`gpt-4o-search-preview`, `gpt-4o-mini-search-preview`) searches the web itself
inside a normal `chat()` call and attaches `url_citation` annotations — no extra
key, no Serper, no scrape loop. In our client this is automatic: `openai.ts`
detects a search-preview model by name and (a) **omits `temperature`** (these
models 400 on it) and (b) sends `web_search_options: {}` to enable search,
**instead of** forwarding function tools. Every non-search model
(`gpt-4.1`, `gpt-4o-mini`, …) is sent exactly as before — temperature included,
function tools forwarded — so nothing else changes. This is distinct from
`webSearch:'native'`, which routes to the **Responses API** `web_search` tool;
that path is unchanged and still works for any Responses-capable model.

**How this differs from the self-hosted OpenSERP/Firecrawl path.** Built-in
search is the **model's own** search (OpenAI's index, one call, costs more per
call). The self-hosted **OpenSERP + Firecrawl** loop
(`web:external` + `scrape`, see [search-and-scrape.md](./search-and-scrape.md))
is **our** search/scrape — no paid search key, fully self-hostable, and it can
**read** (scrape) a specific page, which built-in search does not. Built-in
search is the cheap, zero-setup default; the self-hosted loop is for self-hosters
who want their own search budget and page-reading.

**Cost note.** Search-preview models cost **more** than plain `-mini` (you pay
for the search step on top of tokens). For high-volume runs where the column
doesn't need live web data, pick a cheaper non-search model per Dogi.

**How to change the model** (the default stays fully user-overridable):
- **Per-Dogi brain picker** — each Dogi's `brain` (`provider` + `model` + key)
  overrides the default for that column. This is the primary, per-column switch.
- **Bone / global default** — the env `LLM_MODEL` (and `LLM_PROVIDER`) sets the
  fallback brain when a Dogi pins no model. Set
  `LLM_MODEL=gpt-4.1` (or `claude-opus-4-8`, etc.) to change it globally.
- Any valid model id works in either place; only `*-search-preview` ids get the
  built-in-search request shaping above.

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
