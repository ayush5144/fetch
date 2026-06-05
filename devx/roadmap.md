# Roadmap — what we change/build

Leads-section first. Each phase ships something usable and keeps the existing
backend (jobs, validation, sending, events, self-host) intact. Order is chosen so
the grid is usable early and Dogi lands on top of it.

> Not started — this is the agreed plan. We build after sign-off on the devx docs.

---

## Phase A · Multi-table foundation
- `tables` table; `table_id` on `leads` + `columns`; `(table_id, key)` unique.
- Migration backfilling existing data into a default "Leads" table.
- API: `GET/POST/PATCH/DELETE /tables`; scope leads/columns endpoints by table.
- **Overview** lists/creates tables and adds leads.
- *Done when:* you can create a table, add leads, and open it.
→ [multi-table.md](./multi-table.md)

## Phase B · The Clay grid
- Rebuild `apps/web/app/leads` as the spreadsheet grid.
- Trailing **`+ Add column`** with an **inline create popover**.
- Row numbers, selection checkboxes, inline **`+ new lead`**, inline cell edit.
- Column header **`▷ Run`** + **`⋯` menu** (run/edit/rename/duplicate/delete).
- **Cell states** (empty/queued/running/filled/error) + value·confidence·source.
- *Done when:* the grid feels like Sheets/Clay and drives runs per cell/column.
→ [leads-grid.md](./leads-grid.md)

## Phase C · Dogi (simple, single cell)
- Unify `enrichment`+`agent` column types into **`dogi`**; keep formula/manual.
- Dogi config form: instruction, reads, **output (create new / map to existing)**,
  **web-search toggle**, brain.
- A Dogi run can **create a column** (preview + confirm + audit), not just fill one.
- LLM layer: add **Gemini + Grok** (alongside Anthropic/OpenAI); **native web
  search** path; **BYOK + env** key resolution.
- Web-search backends selectable: `off | native | serper | firecrawl`.
- *Done when:* a user configures a Dogi, picks create-or-map for its output, and
  it fills/creates a column with provenance, using any of the four providers.
→ [dogi-agent.md](./dogi-agent.md) · [providers-and-keys.md](./providers-and-keys.md)

## Phase D · Goal mode (Dogi plans + builds columns)
- **"Ask Dogi"** entry point: a goal → an LLM **planner** returns an ordered
  plan of cell-Dogis with dependencies (step 2 reads step 1's output).
- **Review-and-approve** the plan (rename, map to existing, toggle search, drop
  steps) before any column is created.
- Create the columns, then run steps **in dependency order** (reusing the engine's
  fan-out + run-only-if-empty).
- *Done when:* "find CEO email, then write a custom email" builds two columns and
  fills them end-to-end after one approval.
→ [dogi-agent.md §6](./dogi-agent.md)

## Phase E · Saved agents, cost, test-5
- `agents` table: **save / name / reuse** a Dogi or a whole goal-plan.
- **Cost estimate** before a run (pricing + token counting).
- **Test 5 rows** before a full-table run.
- *Done when:* a user builds a Dogi/plan once and reuses it; sees cost; tests safely.

## Phase F · Dogi advanced (stretch)
- Typebot/n8n-style **visual flow editor** authoring the same `config.flow` /
  plan, with create/map outputs wired as nodes.
- Node palette: input · web search · scrape · LLM step · formula · branch · output.
- *Done when:* a multi-step agent can be wired visually and runs identically.
→ [dogi-agent.md §8](./dogi-agent.md)

## Phase G · Optional dedupe + Accounts fold
- Per-table **dedupe policy** (None default / by column(s) / by company).
- `ingestLead` takes an explicit policy; `accounts` find-or-create becomes opt-in.
- Remove Accounts from the headline nav (keep table/API for "companies as a table").
- *Done when:* the operator chooses if/how rows merge; nothing is force-merged.
→ [dedupe-and-accounts.md](./dedupe-and-accounts.md)

## Phase H · MCP — Fetch as an agent-operable product (optional, off critical path)
- **Fetch MCP server**: expose tables/leads/columns/runs to external AI clients
  (Claude Desktop, Cursor…), read-only first then write tools — async/job-aware,
  cost/dry-run, honoring the gate, with provenance, scoped `FETCH_API_TOKEN` auth,
  and audit. A thin adapter over the same API/engine.
- **Fetch as MCP client**: let a Dogi use external MCP servers a user registers,
  opt-in per Dogi, alongside native/serper/firecrawl.
- *Not in the critical path* — the grid + Dogi ship on direct internal tools first.
→ [mcp.md](./mcp.md)

---

## Phase I · Doggo — the autonomous orchestrator (next big direction)
The cell agent (**Dogi**) only *enriches existing rows*; it cannot *create* them.
A real prompt — *"list the top 10 companies, their CEOs, and LinkedIn profiles"* —
created the right columns but **zero rows**, so nothing ran. Fix: a second,
autonomous agent **Doggo** that can **source/create rows**, build & configure
columns, pick the Dogi per column, and plan→run a whole goal. Defaults to
**propose-a-plan** (toggle to "just do it"); its settings (and the default Dogi
config it hands out) are configurable. Doggo uses Dogi as its hands and needs no
MCP to function. Full design → [doggo.md](./doggo.md).

---

## Session findings & decisions — 2026-06-06 (review, not yet built)

A review of the live product surfaced these. Logged here so the next build picks
them up; full reasoning in [doggo.md](./doggo.md).

**Problems found**
- "Top 10 companies" prompt → 3 correct dogi columns but **0 rows**, nothing ran.
  Root cause: the planner only adds columns "for every lead"; there is **no
  row-creation** anywhere. → Doggo (Phase I).
- New tables start with **0 rows** — an empty grid is a dead end ("no rows yet").
- No obvious **loading state** while an agent works (the machinery exists:
  `queued → running` cell states + `/cell-jobs` polling — just not loud).
- Overview shows **cards**; we'd previously leaned **list**.
- No **agent activity log** surface (though `audit_log` already records actions).

**My take (agreed by the user) — small fixes**
- New table seeds **one blank row** (index `1`); checkbox + index columns are
  already structural — no preset content columns.
- Make the **`running`** cell state visually obvious (spinner/pulse + a header
  "Doggo working…" hint).
- Add an **Agent activity log** view over `audit_log` (next to Jobs).
- Overview **as a list**, not cards.

**Investigated & cleared**
- "Is the Dogi config modal only visual?" — **No.** Manually-created dogi columns
  persist full config in Postgres; the form emits `brain`; `runDogi` consumes
  `sources`/`policy`/`brain` (verified live). Not a bug.

**Already shipped this session** (committed locally, see main checklist)
- Dogi prompt split (research vs transform) — fixed LLM-only columns returning null.
- Dedupe **existing** rows from the column `⋯` menu (+ backend + tests).
- Nav restructure, **Agents** page, **Settings** (key-status) page, `✉→@`.

---

## Explicitly deferred (still in the repo, not the focus now)
Campaigns, Prompts (kept for personalization), Reply inbox, Analytics, standalone
Accounts. The send/validate/event backend stays and keeps passing its tests.

## Guardrails we keep through all phases
- Postgres single source of truth; API enqueues, workers do slow work.
- Enrich in place; value + confidence + source on every Dogi cell.
- No secrets in code/logs; BYOK keys never persisted; webhooks signed; endpoints
  rate-limited.
- Tests stay green (`pnpm test`); typecheck + lint + build clean per phase.
