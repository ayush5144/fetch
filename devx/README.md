# Fetch DevX — direction & working docs

Forward-looking design for the next phase of Fetch: turning the leads area into
a **Clay-style workspace** with a fully customizable enrichment agent (**Dogi**).

This folder is where we **plan and align before building**. It is not the
architecture-of-record — that's `../dev_notes/` (PRD, ARCHITECTURE) and
`../docu.md` (what's built today). Treat everything here as **agreed design we
are about to implement**, written so anyone can pick it up.

> Status: **PLANNING** — nothing here is built yet. We document, agree, then build.

## The one-line shift

From *"a table-first GTM OS"* (built) → to *"open-source Clay you can self-host:
many tables, a spreadsheet you operate, and a customizable agent (Dogi) that
fills any cell — using your keys or ours."*

## Index

| Doc | What it covers |
|---|---|
| [direction.md](./direction.md) | The locked decisions and why. Read this first. |
| [dogi-agent.md](./dogi-agent.md) | **Dogi** — the customizable fetch agent: config, web search, **creating columns + goal mode** (plan a request into several columns), simple vs advanced (Typebot-style), saved agents. |
| [leads-grid.md](./leads-grid.md) | The Clay/Sheets grid: inline `+ column`, per-cell run, cell states, add-row, header menus. |
| [multi-table.md](./multi-table.md) | Many tables per workspace; Overview creates/picks tables. Data model + migration. |
| [providers-and-keys.md](./providers-and-keys.md) | Four LLM providers, native vs our web search, BYOK + env keys, cost estimate, OpenClay reuse. |
| [dedupe-and-accounts.md](./dedupe-and-accounts.md) | Make dedupe **optional + user-chosen**; what happens to the Accounts section. |
| [roadmap.md](./roadmap.md) | Phased plan of what we change/build, leads-section first. |

## What we keep (don't rebuild)

The backend already does the hard parts and stays: Postgres single source of
truth, pg-boss jobs (retry/dead-letter), validation gate, send adapters
(Instantly/Smartlead), webhook events, self-host. The next phase is mostly
**data model (multi-table) + the leads UI + the Dogi agent**, sitting on top of
what exists.

## Reference: OpenClay

`/Users/ayush/dev/Altclay` (OpenClay) is our UX reference for enrichment:
multi-provider, native web-search toggle, cost estimation, test-before-run, BYOK.
It has no backend — we do. We **port its ideas into our engine**, not the
reverse. See [providers-and-keys.md](./providers-and-keys.md) for the licensing note.
