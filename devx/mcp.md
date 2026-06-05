# Does Dogi need an MCP to touch tables?

**Short answer: No for internal data; yes as an optional external boundary.**

MCP (Model Context Protocol) is a standard for exposing tools/resources **across
a boundary** between an LLM client and an external system. Inside our own backend
there is no boundary to cross — Dogi and the tables live in the same process — so
MCP there is pure overhead. MCP becomes valuable precisely where Fetch meets the
*outside*. Three cases:

---

## 1. Dogi → our own tables — **no MCP** (direct internal tools)

When Dogi reads a lead's columns, writes a cell, or creates a column, it's
talking to **our own** Postgres through **our own** code. That should be a
**direct internal tool layer**, not a protocol hop.

We already have the seam: the agent's `Tool` interface
(`packages/agent/src/tools/`). Dogi's table access is just more tools in that
registry, calling the engine/DB directly:

| Internal tool | Backed by |
|---|---|
| `read_row(reads)` | the lead row + `data` |
| `write_cell(key, value, conf, source)` | `columns/cell.ts` `writeCell` |
| `create_column(key, type, config)` | `columns` CRUD (preview + confirm) |
| `query_rows(filter)` | `leads` query (for aggregate/lookup Dogis) |
| `web_search` / `scrape_url` | existing serper / firecrawl tools |

Why direct, not MCP, internally:
- **Faster** — a function call, not a JSON-RPC round trip.
- **Type-safe + transactional** — same process, same DB transaction, real types.
- **Simpler auth** — no second auth/permission surface inside our own worker.

So the core loop (Phase C/D) uses **internal tools**. No MCP required to ship
Dogi.

---

## 2. Fetch **as an MCP server** — yes, optional, high value (outbound)

This is what Clay's "MCP (Beta)" does: expose your workspace so an **external**
AI client (Claude Desktop, Cursor, ChatGPT, another agent) can **operate Fetch
from outside**.

A `fetch-mcp` server would wrap the API we're already building and expose tools
like:

```
list_tables() · create_table(name)
list_leads(table) · add_lead(table, fields)
list_columns(table) · create_column(table, dogi_config)
run_column(table, column, filter) · run_cell(lead, column)
get_results(table)
```

- **Why it's valuable:** "drive my GTM from my own AI assistant" — build a table,
  add leads, fire a Dogi, read results, all from Claude/Cursor without our UI.
- **Low marginal cost:** it's a thin adapter over the REST API + the same auth
  (`FETCH_API_TOKEN`). Build it **after** the API/grid stabilize.
- **Self-host friendly:** ships as an optional process; doesn't touch the baseline.

## 3. Dogi **as an MCP client** — yes, optional, for pluggable tools (inbound)

Let a Dogi use **external** MCP servers the user configures (their CRM, internal
data lake, a niche search MCP) as **extra tools**, alongside
`native | serper | firecrawl`.

- Fits the customizability theme: a Dogi's tool list becomes **"native search +
  our tools + any MCP server you connect."**
- The user **registers** an MCP endpoint and **toggles which Dogis may use it**
  (explicit opt-in, like every other Dogi capability).
- Makes the toolset extensible **without us coding each integration**.

---

## 4. Recommendation & sequencing

| Capability | Build when | Why |
|---|---|---|
| **Internal table tools** (Dogi ↔ our DB) | **Phase C/D (now)** | required for the core loop; MCP would only slow it |
| **Fetch-as-MCP-server** (external clients drive Fetch) | **later, optional** | thin wrapper over the API; great for power users; mirrors Clay |
| **Dogi-as-MCP-client** (external MCP tools in a Dogi) | **later, optional** | extensible toolset; pairs with advanced/flow mode |

So: **don't** put MCP in the critical path. Ship Dogi on direct internal tools.
Then add MCP **outward** (server) and **inward** (client) as deliberate, optional
capabilities once the core is solid.

## Security notes (when we do add MCP)
- The MCP **server** reuses `FETCH_API_TOKEN` auth; never exposes secrets; respects
  the same rate limits.
- The MCP **client** only calls servers the user explicitly registered, and only
  for Dogis they explicitly enabled; tool calls are audited; no key leakage.
- BYOK keys never flow into an MCP payload.
