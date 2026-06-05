# MCP — Fetch as an agent-operable product

This is a **project-wide** plan, not a Dogi sub-feature. MCP (Model Context
Protocol) is how Fetch is **operated by, and connected to, AI agents** — the same
way Clay ships an "MCP (Beta)". The goal: expose Fetch's whole surface to external
agents **with the same guarantees the UI has** (provenance, the validation gate,
cost-before-run, async jobs, audit) — never a thin RPC wrapper that bypasses them.

> Status: PLANNING. Off the critical path — we build the grid + Dogi on direct
> internal calls first, then add MCP as a deliberate capability.

---

## 1. Why MCP for Fetch

Fetch is a system of records + operations (tables, leads, columns, runs, sends).
That is exactly the shape an external agent wants to drive: "make a table, add
these leads, find their CEOs, write emails, tell me who replied." MCP gives that
agent a typed, discoverable surface. Two directions:

| Direction | Meaning | Priority |
|---|---|---|
| **Fetch as MCP server** | External AI clients (Claude Desktop, Cursor, ChatGPT, custom agents) **operate** your Fetch workspace | Primary |
| **Fetch as MCP client** | Fetch (a Dogi) **consumes** external MCP servers (your CRM, data lake, niche search) as extra tools | Secondary |

The internal case — Dogi reading/writing **our own** tables — is **not** MCP. That
stays a direct in-process tool layer (faster, type-safe, transactional). MCP is
for the boundary with the outside.

---

## 2. Fetch MCP server — the surface

The server mirrors the **same primitives as the UI/REST API**, so there is one
mental model. Resources are read context; tools are actions.

### 2.1 Resources (read — the model pulls these in)

| Resource | Returns |
|---|---|
| `tables` | every table: id, name, row/column counts |
| `table/{id}/schema` | the table's columns (key, label, type, Dogi config) |
| `table/{id}/rows` | leads (paginated, filterable), each cell value |
| `lead/{id}` | one lead's full record **+ per-cell provenance** (confidence, source) |
| `agents` | saved Dogis / plans (name, config) |
| `prompts` | versioned templates |
| `jobs/{id}` | a run's status/progress/error |
| `analytics/{table}` | funnel + run metrics |

### 2.2 Tools (act — grouped by domain)

| Group | Tools |
|---|---|
| **Tables** | `create_table` · `rename_table` · `delete_table` · `list_tables` |
| **Leads** | `add_leads` · `import_csv` · `update_cell` · `query_rows` · `delete_rows` |
| **Columns** | `create_column(dogi_config)` · `edit_column` · `delete_column` · `list_columns` |
| **Dogi / runs** | `run_column` · `run_cell` · `ask_dogi(goal)` → returns a **plan** to approve · `estimate_cost(run)` |
| **Validation** | `validate(table\|leads)` |
| **Sending** | `create_campaign` · `launch(campaign)` *(gated)* |
| **Agents** | `save_agent` · `use_agent` |

Each tool maps to an endpoint/function we are already building:

```
create_table        → POST /tables
add_leads/import    → POST /tables/:id/leads · /import
create_column       → POST /tables/:id/columns      (Dogi config)
run_column/run_cell → POST /columns/:key/run · /leads/:id/run/:key  → returns job id
ask_dogi(goal)      → the planner (Phase D) → returns a dogi-plan
launch              → POST /campaigns/:id/launch     (validation + approval gate)
```

---

## 3. What makes it *ideal* (the qualities, not the tool list)

The tools are easy; these properties are what make an MCP good for a Clay/Fetch:

1. **Same primitives as UI/REST** — the MCP is an agent-native *view* of the same
   operations, not a parallel brain. No tool can do something the gate would block.
2. **Async-native** — enriching 10k rows can't block a tool call. Run tools
   return a **job id**; the client polls `jobs/{id}` or subscribes to progress.
3. **Cost + dry-run before expensive/irreversible actions** — `estimate_cost`
   and a `dryRun` flag on big runs and sends; surface the estimate before firing.
4. **Human-in-the-loop for risk** — `ask_dogi` returns a **plan to approve** (not
   auto-build); `launch` honors the validation+approval **gate**; destructive
   tools require explicit confirmation. The agent proposes; a human/policy commits.
5. **Provenance in responses** — every enriched value returns `{value,
   confidence, source}` so the external agent can **trust and cite** it.
6. **Auth, scoping, least privilege** — token auth (`FETCH_API_TOKEN`), a
   **read-only vs read-write** mode, per-table/workspace scope, tenant isolation
   if hosted.
7. **Idempotent + stable ids** — retries are safe (our jobs already are); tools
   return durable ids so a re-call doesn't double-send or double-charge.
8. **Pagination + server-side filtering** — tables get huge; cursor pagination,
   not "dump everything."
9. **Live updates** — subscribe to job completion / row changes (MCP resource
   updates) so the client stays current instead of blind-polling.
10. **BYOK passthrough clarity** — when an external agent triggers enrichment, be
    explicit about *whose key pays* (server env key vs a caller-supplied key);
    BYOK keys are never persisted or logged.
11. **Audit** — every MCP action is recorded with `actor = <that client>`.
12. **Schema fidelity** — expose column types + Dogi configs so the agent
    *understands* the table it's operating, not just opaque cells.

---

## 4. Transport, auth, and shape

- **Transports:** `stdio` (local clients like Claude Desktop/Cursor) and
  **streamable HTTP** (remote/hosted). Same tool/resource definitions behind both.
- **Auth:** reuse `FETCH_API_TOKEN`. A token can be minted **read-only** or
  **read-write**, and optionally **scoped to specific tables**.
- **Packaging:** a separate optional process/app (`apps/mcp` or
  `packages/mcp-server`) that calls the same API/engine. Ships in the self-host
  compose as an opt-in service; **not** in the baseline.
- **Discoverability:** clear tool names, descriptions, and JSON-Schema inputs;
  resource templates; actionable error messages (an agent reads these).

---

## 5. Fetch as an MCP **client** (Dogi's external tools)

The inbound direction makes a Dogi's toolset extensible without us coding each
integration:

- A user **registers** an external MCP server (endpoint + auth) in settings.
- A Dogi can be configured to use it: its tool list becomes **`native search +
  our tools (serper/firecrawl) + any enabled MCP server`**.
- **Opt-in per Dogi** — like every Dogi capability, the user toggles which MCP
  tools a given agent may call.
- Tool calls are **audited**; BYOK/keys never leak into MCP payloads.

This pairs naturally with advanced/flow mode (an MCP tool is just another node).

---

## 6. Security rules (non-negotiable)

- The MCP **server** enforces the same gates as the API: validation gates sending;
  rate limits apply; no secrets ever returned to a client.
- **Read-only tokens** cannot mutate; **scoped tokens** cannot touch other tables.
- The MCP **client** only calls servers the user explicitly registered, only for
  Dogis explicitly enabled, and never forwards Fetch secrets or BYOK keys.
- Every MCP action lands in `audit_log` with the client as actor.

---

## 7. Sequencing & open questions

**Sequencing:** internal Dogi tools (Phase C/D) → grid/Dogi solid → **then** the
MCP server (read-only first, then write tools) → **then** the MCP client. See the
checklist Phase H.

**Open questions to resolve before building MCP:**
- Read-only vs read-write default for a fresh token?
- For `ask_dogi` over MCP, does approval happen in the Fetch UI, or can a trusted
  client auto-approve under a policy/budget?
- BYOK over MCP: do we accept a caller-supplied key per call, or only server keys?
- Hosted multi-tenant scoping model (deferred while self-host-first)?
