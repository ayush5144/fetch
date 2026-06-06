# Running the search stack (self-hosted, opt-in)

> Operational runbook for the **optional** web-search + scrape dependencies the
> Dogi research loop can use for real web data with **no paid API keys**. This is
> NOT part of the baseline boot — `scripts/dev.sh` still comes up with just
> Postgres. Design rationale lives in `devx/search-and-scrape.md`; this file is
> the "how to run it."

## TL;DR

```bash
# Everything (OpenSERP + Firecrawl):
docker compose -f docker-compose.search.yml up -d
# or: scripts/search.sh up

# Just OpenSERP (light, no Firecrawl fleet):
docker compose -f docker-compose.search.yml up -d openserp
# or: scripts/search.sh up-openserp

# Tear down:
docker compose -f docker-compose.search.yml down
```

Then in `.env`:

```
OPENSERP_URL=http://localhost:7001
OPENSERP_ENGINE=yandex
FIRECRAWL_API_URL=http://localhost:3002
```

Compose file: `docker-compose.search.yml` (repo root). Helper: `scripts/search.sh`.

## Services, images, ports

| Service | Container | Image (pinned by digest, captured 2026-06-06) | Host → container |
|---|---|---|---|
| OpenSERP (SERP) | `fetch-openserp` | `karust/openserp` @ `sha256:ba72e41f…cae9a6eb` | **7001 → 7000** |
| Firecrawl API | `fetch-firecrawl-api` | `ghcr.io/firecrawl/firecrawl` @ `sha256:f17f8b8d…e55f56c9` | **3002 → 3002** |
| Firecrawl Playwright | `fetch-firecrawl-playwright` | `ghcr.io/firecrawl/playwright-service` @ `sha256:443030be…06cfa1017` | internal |
| Firecrawl Redis | `fetch-firecrawl-redis` | `redis:alpine` | internal |
| Firecrawl RabbitMQ | `fetch-firecrawl-rabbitmq` | `rabbitmq:3-management` | internal |
| Firecrawl nuq-postgres | `fetch-firecrawl-nuq-postgres` | `ghcr.io/firecrawl/nuq-postgres` @ `sha256:f9388bd2…43a95a33` | internal |

`karust/openserp` publishes only a `:latest` tag on Docker Hub, so it is pinned
by digest. Firecrawl uses its **published** images (no local source build) — also
pinned by digest. To refresh any of them: re-pull `:latest`, read the new digest
with `docker inspect <img> --format '{{index .RepoDigests 0}}'`, and update the
compose.

## Env vars (precedence)

The app prefers the self-hosted backend; the hosted API key is the fallback.

| Var | Example | Meaning |
|---|---|---|
| `OPENSERP_URL` | `http://localhost:7001` | When set → use OpenSERP for `web_search`. |
| `OPENSERP_ENGINE` | `yandex` | `google` \| `yandex` \| `baidu`. Default `yandex` for local (see caveat). |
| `SERPER_API_KEY` | — | Hosted `web_search` fallback, used only if `OPENSERP_URL` is unset. |
| `FIRECRAWL_API_URL` | `http://localhost:3002` | When set → use self-hosted Firecrawl for scrape. |
| `FIRECRAWL_API_KEY` | — | Hosted scrape fallback (or auth for a secured self-host). |

Precedence:
`OPENSERP_URL` > `SERPER_API_KEY` > web_search off ·
`FIRECRAWL_API_URL` > `FIRECRAWL_API_KEY` > scrape off.

## OpenSERP — Yandex vs Google CAPTCHA caveat (important)

OpenSERP drives a real headless browser against a search engine, so from a
**datacenter / server IP** the engines behave very differently:

- **Google is CAPTCHA-blocked** from a datacenter IP — requests return
  `429 {"error":"captcha_detected"}`. Google realistically needs a
  **non-datacenter (residential) IP** to work. Don't default to it for local/CI.
- **Yandex works** and returns real organic results (titles, URLs, snippets —
  including `linkedin.com/in/...` links, which is the reliable path for "find the
  LinkedIn URL" tasks: take the result link, don't scrape LinkedIn).
- Yandex still **rate-limits under bursty use** — rapid repeated queries can
  themselves trip `429 captcha_detected`. Space requests out and cache results.

So: default `OPENSERP_ENGINE=yandex` for self-host/local; switch to `google` only
on a residential IP.

## Firecrawl footprint

Non-trivial. The self-host is a **5-container fleet** (api + playwright + redis +
rabbitmq + nuq-postgres), and the `api` alone is provisioned up to **8G RAM /
4 CPU** with playwright up to 4G / 2 CPU (limits in the compose; lower them if
you're tight). The api takes ~30–60s after `up` before `/v1/scrape` answers.

Notes:
- No API key is required for the self-hosted scrape.
- `nuq-postgres` is an **amd64-only** image; on Apple Silicon it runs under
  emulation (works, a bit slower). You'll see a harmless platform-mismatch warning.
- This runbook uses Firecrawl's **published images**, so no Go/Rust/Node source
  build is needed. If you'd rather build from source, clone
  `https://github.com/firecrawl/firecrawl`, copy `apps/api/.env.example` to
  `.env`, and `docker compose up -d` from that repo (its compose builds `apps/api`,
  `apps/playwright-service-ts`, and `apps/nuq-postgres` locally — a heavier path).

## Smoke tests

OpenSERP (Yandex):

```bash
curl -s "http://localhost:7001/yandex/search?text=anthropic+claude&lang=EN&limit=2"
# → {"query":{...},"results":[{"title":"…","url":"https://…","snippet":"…"}, …]}
```

Firecrawl scrape → markdown:

```bash
curl -s -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
# → {"success":true,"data":{"markdown":"Example Domain\n=====…","metadata":{…}}}
```

`scripts/search.sh smoke` runs both. `scripts/search.sh status` shows container
state.

## Status in this environment (verified 2026-06-06)

- **OpenSERP — running & verified.** `fetch-openserp` on host 7001; Yandex
  returns real results. Google is CAPTCHA-blocked from this IP (as expected).
  Yandex also intermittently 429s under bursty calls.
- **Firecrawl — running & verified.** Full 5-container fleet up via
  `docker-compose.search.yml`; `POST /v1/scrape` for `https://example.com`
  returned `success:true` with clean markdown.
