/**
 * The Fetch MCP tool registry.
 *
 * Each tool is a thin wrapper over one Fetch REST endpoint (via `FetchClient`).
 * The registry is a PURE FUNCTION of `{ client, readOnly }` so it can be unit
 * tested without starting stdio: in read-only mode ONLY the read tools are
 * registered (so write tools never appear in `tools/list`); in read-write mode
 * the write tools are appended.
 *
 * Honors devx/mcp.md §3: async-native (run_* return job ids — poll get_job),
 * provenance in row/lead responses (`enrichmentConf` is returned verbatim),
 * human-in-the-loop (`ask_bone` returns a plan; `run_bone` is the explicit
 * commit), pagination on query_rows, least privilege (read-only default).
 */

import { z } from 'zod';
import type { FetchClient } from './client.js';
import { FetchApiError } from './client.js';

/** The MCP CallTool result shape we return (content + optional isError). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** One registered tool: name, description, a zod input schema, and a handler. */
export interface ToolDef {
  name: string;
  description: string;
  /** zod object schema for the tool's arguments (shape map). */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Marks write tools, so callers/tests can distinguish them. */
  write: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Wrap a JSON value as an MCP text-content result. */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Wrap an error message as an MCP isError result (NOT a thrown exception). */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Run a tool handler and translate any API/validation failure into an isError
 * result carrying the API's own message — an agent reads it and self-corrects.
 */
export async function runTool(
  def: ToolDef,
  rawArgs: unknown,
): Promise<ToolResult> {
  const parsed = def.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments for ${def.name}: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  try {
    const out = await def.handler(parsed.data as Record<string, unknown>);
    return jsonResult(out);
  } catch (err) {
    if (err instanceof FetchApiError) return errorResult(err.message);
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ── Read tools (always registered) ────────────────────────────────────────────

function readTools(client: FetchClient): ToolDef[] {
  return [
    {
      name: 'list_tables',
      description:
        'List every table in the workspace with its id, name, and row/column counts.',
      inputSchema: z.object({}),
      write: false,
      handler: () => client.get('/tables'),
    },
    {
      name: 'get_table_schema',
      description:
        "Get a table's columns (key, label, type, and config) so you understand its shape before reading or writing.",
      inputSchema: z.object({ tableId: z.string().min(1) }),
      write: false,
      handler: (a) => client.get(`/tables/${enc(a.tableId)}/columns`),
    },
    {
      name: 'query_rows',
      description:
        "Read a table's rows (leads) with cell values and per-cell provenance (enrichmentConf: value confidence + source). Supports pagination.",
      inputSchema: z.object({
        tableId: z.string().min(1),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
      write: false,
      handler: async (a) => {
        const all = await client.get<{ leads: unknown[] }>(
          `/tables/${enc(a.tableId)}/leads`,
        );
        return paginate(all.leads ?? [], a.limit as number | undefined, a.offset as number | undefined);
      },
    },
    {
      name: 'get_lead',
      description:
        "Get one lead's full record including per-cell provenance (enrichmentConf: confidence + source for each enriched value).",
      inputSchema: z.object({ leadId: z.string().min(1) }),
      write: false,
      handler: (a) => client.get(`/leads/${enc(a.leadId)}`),
    },
    {
      name: 'get_job',
      description:
        'Get the status/progress/error of background jobs. Run tools are async and return job ids — poll this until terminal. Optionally filter by status or type, or pass a jobId to fetch one.',
      inputSchema: z.object({
        jobId: z.string().optional(),
        status: z.string().optional(),
        type: z.string().optional(),
      }),
      write: false,
      handler: async (a) => {
        const qs = new URLSearchParams();
        if (a.status) qs.set('status', String(a.status));
        if (a.type) qs.set('type', String(a.type));
        const list = await client.get<{ jobs: Array<{ id: string }> }>(
          `/jobs${qs.toString() ? `?${qs}` : ''}`,
        );
        if (a.jobId) {
          const job = (list.jobs ?? []).find((j) => j.id === a.jobId);
          return job ?? { error: `no job with id ${a.jobId}` };
        }
        return list;
      },
    },
    {
      name: 'recent_activity',
      description:
        'Read the workspace audit feed (newest first): tables/columns created, cells filled, dedupe, plans, who did what. Paginated.',
      inputSchema: z.object({
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
      write: false,
      handler: (a) => {
        const qs = new URLSearchParams();
        if (a.limit != null) qs.set('limit', String(a.limit));
        if (a.offset != null) qs.set('offset', String(a.offset));
        return client.get(`/activity${qs.toString() ? `?${qs}` : ''}`);
      },
    },
  ];
}

// ── Write tools (registered ONLY when not read-only) ──────────────────────────

function writeTools(client: FetchClient): ToolDef[] {
  return [
    {
      name: 'create_table',
      description:
        'Create a new table. A fresh table is seeded with one blank row so it is never a dead end.',
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        icon: z.string().optional(),
      }),
      write: true,
      handler: (a) => client.post('/tables', a),
    },
    {
      name: 'create_column',
      description:
        "Add a column to a table. `type` is one of manual | formula | dogi. For a Dogi (enrichment/agent) column, pass its config (instruction, sources, etc.). `key` must be snake_case.",
      inputSchema: z.object({
        tableId: z.string().min(1),
        key: z
          .string()
          .min(1)
          .regex(/^[a-z0-9_]+$/, 'key must be snake_case (a-z, 0-9, _)'),
        label: z.string().min(1),
        type: z.string().min(1),
        config: z.record(z.unknown()).optional(),
      }),
      write: true,
      handler: (a) =>
        client.post(`/tables/${enc(a.tableId)}/columns`, {
          key: a.key,
          label: a.label,
          type: a.type,
          config: a.config ?? {},
        }),
    },
    {
      name: 'add_leads',
      description:
        'Add one or many rows (leads) to a table. Each row is an object of field→value (e.g. firstName, lastName, email, title, company, domain). Goes through ingestion, so the table dedupe policy applies. Returns one result per row.',
      inputSchema: z.object({
        tableId: z.string().min(1),
        rows: z.array(z.record(z.unknown())).min(1),
      }),
      write: true,
      handler: async (a) => {
        const rows = a.rows as Array<Record<string, unknown>>;
        const results: unknown[] = [];
        for (const row of rows) {
          results.push(await client.post(`/tables/${enc(a.tableId)}/leads`, row));
        }
        return { count: results.length, results };
      },
    },
    {
      name: 'update_cell',
      description:
        "Inline-edit one cell of a lead (no job). Overrides any computed value. Typed columns validate the value first.",
      inputSchema: z.object({
        leadId: z.string().min(1),
        columnKey: z.string().min(1),
        value: z.unknown(),
      }),
      write: true,
      handler: (a) =>
        client.patch(`/leads/${enc(a.leadId)}/cell`, {
          key: a.columnKey,
          value: a.value,
        }),
    },
    {
      name: 'run_column',
      description:
        'Run a column over a table (async). Enqueues an enrich job per empty cell (or all with force). Use `limit` to test the first N rows. Returns enqueued count / job ids — poll get_job for completion.',
      inputSchema: z.object({
        tableId: z.string().min(1),
        columnKey: z.string().min(1),
        leadIds: z.array(z.string()).optional(),
        limit: z.number().int().nonnegative().optional(),
        force: z.boolean().optional(),
      }),
      write: true,
      handler: (a) =>
        client.post(`/tables/${enc(a.tableId)}/columns/${enc(a.columnKey)}/run`, {
          leadIds: a.leadIds ?? [],
          force: a.force ?? false,
          ...(a.limit != null ? { limit: a.limit } : {}),
        }),
    },
    {
      name: 'run_cell',
      description:
        'Run one column for one lead (async). Returns a job id — poll get_job for completion.',
      inputSchema: z.object({
        leadId: z.string().min(1),
        columnKey: z.string().min(1),
      }),
      write: true,
      handler: (a) =>
        client.post(`/leads/${enc(a.leadId)}/run/${enc(a.columnKey)}`, {}),
    },
    {
      name: 'dedupe',
      description:
        'Dedupe rows already in a table by one or more key columns. Set `preview: true` to see how many clusters/rows WOULD merge without mutating; otherwise it merges (keeps the oldest, fills its empties, deletes dupes). Idempotent.',
      inputSchema: z.object({
        tableId: z.string().min(1),
        keys: z.array(z.string().min(1)).min(1),
        preview: z.boolean().optional(),
      }),
      write: true,
      handler: (a) => {
        const keys = a.keys as string[];
        if (a.preview) {
          const qs = new URLSearchParams({ keys: keys.join(',') });
          return client.get(`/tables/${enc(a.tableId)}/duplicates?${qs}`);
        }
        return client.post(`/tables/${enc(a.tableId)}/dedupe`, { keys });
      },
    },
    {
      name: 'ask_bone',
      description:
        'Ask Bone for a PLAN to achieve a goal on a table (row-sourcing + columns). Returns a plan to review — it does NOT execute. Call run_bone with an approved plan to commit.',
      inputSchema: z.object({
        tableId: z.string().min(1),
        goal: z.string().min(1),
      }),
      write: true,
      handler: (a) =>
        client.post(`/tables/${enc(a.tableId)}/bone/plan`, { goal: a.goal }),
    },
    {
      name: 'run_bone',
      description:
        'Execute an APPROVED Bone plan (the explicit human-in-the-loop commit). Pass the plan returned by ask_bone (optionally edited). Sources rows, creates columns, and enqueues runs. Returns { rowsCreated, columnsCreated, enqueued } — poll get_job for the runs.',
      inputSchema: z.object({
        tableId: z.string().min(1),
        plan: z.object({
          goal: z.string().optional(),
          steps: z.array(z.record(z.unknown())).min(1),
        }),
      }),
      write: true,
      handler: (a) =>
        client.post(`/tables/${enc(a.tableId)}/bone/run`, { plan: a.plan }),
    },
    {
      name: 'estimate_cost',
      description:
        'Estimate the USD cost to run a Dogi over `rows` rows with a given provider/model BEFORE firing. Returns { perRow, total, breakdown }.',
      inputSchema: z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        rows: z.number().int().nonnegative(),
        webSearch: z.boolean().optional(),
      }),
      write: true,
      handler: (a) => client.post('/estimate-cost', a),
    },
  ];
}

/**
 * Build the tool registry. PURE: same inputs → same tool set.
 * read-only → read tools only; read-write → read tools + write tools.
 */
export function buildToolRegistry(opts: {
  client: FetchClient;
  readOnly: boolean;
}): ToolDef[] {
  const tools = readTools(opts.client);
  if (!opts.readOnly) tools.push(...writeTools(opts.client));
  return tools;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Encode a path segment (ids are safe today, but never trust input). */
function enc(v: unknown): string {
  return encodeURIComponent(String(v));
}

/**
 * Apply offset/limit to an in-memory array (the leads endpoint returns the full
 * table; we page client-side so query_rows honors the §3 pagination quality).
 */
function paginate<T>(
  rows: T[],
  limit?: number,
  offset?: number,
): { rows: T[]; limit: number | null; offset: number; total: number } {
  const start = offset ?? 0;
  const slice = limit != null ? rows.slice(start, start + limit) : rows.slice(start);
  return { rows: slice, limit: limit ?? null, offset: start, total: rows.length };
}
