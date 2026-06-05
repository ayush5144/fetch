# Direction — locked decisions

Decisions we agreed in planning. Each is a constraint the build must honor.

## D1 · Many tables, picked in Overview
A workspace holds **multiple tables** (like Clay's workbook tabs). The
**Overview** is where you create and open tables, and add leads. Each table has
its **own columns and rows**. → [multi-table.md](./multi-table.md)

## D2 · The leads grid feels like Google Sheets / Clay
A real spreadsheet surface: a permanent **`+ Add column`** at the right edge,
click-to-create columns inline, **per-cell and per-column `▷ Run`**, row numbers,
selection, column **`⋯` menus**, live **cell states**, and an inline **add-row**.
→ [leads-grid.md](./leads-grid.md)

## D3 · Dogi is the agent, and it's fully customizable
Every enrichment/agent column is a **Dogi** — a small agent you configure and
can save. Customization must be **really simple by default**:
- pick what it **reads** (input columns) and **writes** (output column),
- give it an **instruction**,
- **toggle web search on/off**,
- choose **provider + model**.

Two web-search backends, user's choice: the **LLM provider's native web search**,
**or our own tool** (Serper / Firecrawl).

Dogi is not limited to one cell: it can **create columns**. Each output is
**create-new** or **map-to-existing**, and in **goal mode** Dogi decomposes a
request ("find the CEO's email, then write him a custom email") into multiple
columns it creates and runs in order — with a human reviewing the plan first. An
**advanced mode** offers a **Typebot/n8n-style visual flow** to map a custom
agent's steps and fields. Users can **save** their Dogis and plans (and
enrichments), like they save prompts today. → [dogi-agent.md](./dogi-agent.md)

## D4 · Four providers, wired from the start
Anthropic, OpenAI, Gemini, Grok — all four from day one (Vertex optional later).
→ [providers-and-keys.md](./providers-and-keys.md)

## D5 · BYOK and env keys, both
A user can paste a key in the UI (**BYOK**, never persisted server-side) **or**
set keys in `.env`. Both supported from the start. Per-run/per-agent key
selection. → [providers-and-keys.md](./providers-and-keys.md)

## D6 · Dedupe is optional and user-chosen
Six people from one company are six valid leads — we do **not** force-merge.
Dedupe becomes **opt-in per table**, with the operator choosing the **key
column(s)** and strategy (or none). The **Accounts** section is demoted from a
headline nav item to an optional backend concept. → [dedupe-and-accounts.md](./dedupe-and-accounts.md)

## D7 · Scope now: perfect the leads section
Campaigns, Prompts, Reply inbox, Analytics, and standalone Accounts are
**deferred**. The current goal is the **tables → leads → columns → Dogi** core.
The send/validate/event backend stays intact underneath. → [roadmap.md](./roadmap.md)

## D8 · Reuse OpenClay's ideas, mind the license
OpenClay is open source but currently ships **no license** (= all rights
reserved by default). We freely reuse its **patterns** (provider calls, native
web-search toggle, cost estimation, test-5). Before copying **literal code**,
we get the author's OK or reimplement. → [providers-and-keys.md](./providers-and-keys.md#license)
