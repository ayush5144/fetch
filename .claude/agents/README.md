# Fetch — project agents

Scoped subagent definitions used to build Fetch phase by phase. Each agent has a
narrow remit so its edits stay on a disjoint set of files and reviews stay
focused. They follow the build checklist in `dev_notes/CHECKLIST_fetch.md`.

| Agent | Use it for |
|---|---|
| `fetch-phase-builder` | Implement one checklist phase end-to-end: code + tests, then verify. |
| `fetch-test-author` | Write `vitest` tests for a specific package against its public API. |
| `fetch-hardening` | Security / observability / self-host hardening passes (Phases 11–12). |

## Conventions every agent must keep

- **Postgres is the single source of truth.** No new state stores; enrich in place.
- **The API never does slow work** — it writes a row and enqueues a job.
- **Everything external sits behind an interface** (LLM, providers, send rails).
- Match the surrounding code's style, comment density, and naming.
- Tests are the contract: a phase is "done" when its checklist `Test:` lines pass.
- Touch only the files your task names; never reformat unrelated code.
