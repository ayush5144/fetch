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

## Phase C · Dogi (simple)
- Unify `enrichment`+`agent` column types into **`dogi`**; keep formula/manual.
- Dogi config form: instruction, reads, writes, **web-search toggle**, brain.
- LLM layer: add **Gemini + Grok** (alongside Anthropic/OpenAI); **native web
  search** path; **BYOK + env** key resolution.
- Web-search backends selectable: `off | native | serper | firecrawl`.
- *Done when:* a user configures a Dogi on a column and it fills cells with
  provenance, using any of the four providers, search on or off.
→ [dogi-agent.md](./dogi-agent.md) · [providers-and-keys.md](./providers-and-keys.md)

## Phase D · Saved agents, cost, test-5
- `agents` table: **save / name / reuse** a Dogi (and enrichments).
- **Cost estimate** before a run (pricing + token counting).
- **Test 5 rows** before a full-table run.
- *Done when:* a user builds a Dogi once and reuses it; sees cost; tests safely.

## Phase E · Dogi advanced (stretch)
- Typebot/n8n-style **visual flow editor** authoring the same `config.flow`.
- Node palette: input · web search · scrape · LLM step · formula · branch · output.
- *Done when:* a multi-step agent can be wired visually and runs identically.
→ [dogi-agent.md §6](./dogi-agent.md)

## Phase F · Optional dedupe + Accounts fold
- Per-table **dedupe policy** (None default / by column(s) / by company).
- `ingestLead` takes an explicit policy; `accounts` find-or-create becomes opt-in.
- Remove Accounts from the headline nav (keep table/API for "companies as a table").
- *Done when:* the operator chooses if/how rows merge; nothing is force-merged.
→ [dedupe-and-accounts.md](./dedupe-and-accounts.md)

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
