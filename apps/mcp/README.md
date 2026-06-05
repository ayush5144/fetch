# @fetch/mcp — Fetch MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
external AI (Claude Desktop, Cursor, a custom agent) **operate a Fetch
workspace**: list tables, read rows with provenance, run Dogi enrichment, ask
Doggo for a plan, and more.

It is a **thin adapter over the Fetch REST API** — it holds no business logic and
never touches the database. Every action goes through the same HTTP API the web
UI uses, so auth, validation gates, dedupe, audit, and provenance are reused.
(Design: [`devx/mcp.md`](../../devx/mcp.md); it is a *projection* of the primitive
layer, per [`devx/doggo.md`](../../devx/doggo.md) §7 — never a parallel brain.)

This is an **opt-in** app. It ships only when you run it; it is not part of the
baseline API/worker/web stack.

## Transport

`stdio` (for local clients like Claude Desktop / Cursor). Streamable HTTP is
deferred (see "As built" in `devx/mcp.md`).

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `FETCH_API_URL` | `http://localhost:4000` | Base URL of the Fetch API. |
| `FETCH_API_TOKEN` | _(unset)_ | Optional bearer token. When set, every request sends `Authorization: Bearer <token>`. Mint a read-only token for least privilege. |
| `FETCH_MCP_READONLY` | `true` | **Read-only by default (safe).** Only the read tools are registered. Set to `"false"` to additionally register the write tools. |

## Read-only gating

The gate defaults to **read-only** for safety. In read-only mode the write tools
are **not registered at all**, so they never appear in `tools/list` and cannot be
called. Set `FETCH_MCP_READONLY=false` to expose the write tools.

## Tools

**Read tools** (always available):

- `list_tables` — tables with id/name/row+col counts.
- `get_table_schema` `{tableId}` — columns (key, label, type, config).
- `query_rows` `{tableId, limit?, offset?}` — rows with cell values **+ per-cell
  provenance** (`enrichmentConf`: confidence + source). Paginated.
- `get_lead` `{leadId}` — one lead's full record + provenance.
- `get_job` `{jobId?, status?, type?}` — job status/progress/error (run tools are
  async — poll this).
- `recent_activity` `{limit?, offset?}` — the workspace audit feed.

**Write tools** (only when `FETCH_MCP_READONLY=false`):

- `create_table` `{name, description?, icon?}`
- `create_column` `{tableId, key, label, type, config?}` (supports a Dogi config)
- `add_leads` `{tableId, rows: object[]}` (one or many)
- `update_cell` `{leadId, columnKey, value}`
- `run_column` `{tableId, columnKey, leadIds?, limit?, force?}` → async, returns
  enqueued count
- `run_cell` `{leadId, columnKey}` → async, returns a job id
- `dedupe` `{tableId, keys, preview?}` (`preview: true` is a dry run)
- `ask_doggo` `{tableId, goal}` → returns a **plan to approve** (does NOT execute)
- `run_doggo` `{tableId, plan}` → executes an approved plan (the explicit commit)
- `estimate_cost` `{provider, model, rows, webSearch?}`

Run tools are async-native: they return job ids / enqueued counts; poll `get_job`
for completion. `ask_doggo` → `run_doggo` is the human-in-the-loop pattern (the
agent proposes a plan; a human/policy commits it).

## Resources

The four read primitives are also exposed as MCP resources (templates):

- `fetch://tables`
- `fetch://table/{id}/schema`
- `fetch://table/{id}/rows`
- `fetch://lead/{id}`

## Audit

Every action lands in `audit_log` via the API, with the actor the API assigns
(today the API derives the actor itself; the server also sends an `x-fetch-actor:
mcp` hint, which the API may ignore until it honors that header).

## Run it

```bash
# from the repo root, with the Fetch API running on :4000
pnpm --filter @fetch/mcp dev      # tsx watch, read-only by default

# read-write:
FETCH_MCP_READONLY=false pnpm --filter @fetch/mcp dev
```

## Claude Desktop config

Add to `claude_desktop_config.json` (`mcpServers`):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "pnpm",
      "args": ["--filter", "@fetch/mcp", "start"],
      "cwd": "/absolute/path/to/fetch",
      "env": {
        "FETCH_API_URL": "http://localhost:4000",
        "FETCH_MCP_READONLY": "true"
      }
    }
  }
}
```

To allow writes, set `"FETCH_MCP_READONLY": "false"` and (recommended) a
`"FETCH_API_TOKEN"`. For a packaged build, point `command`/`args` at
`node dist/index.js` after `pnpm --filter @fetch/mcp build`.
