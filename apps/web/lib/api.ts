/**
 * Thin typed client for the Fetch API. The web app is a pure operator UI over
 * the API — every read and action goes through here, so there's one place that
 * knows the base URL and error shape.
 */
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
  base: BASE,
};

// ── Per-cell enrichment state (Phase J · Round 2) ─────────────────────────────
// Each entry in `lead.enrichmentConf[columnKey]` is one of:
//   filled  → { status:'filled', confidence, source, provider? }
//             (legacy: has confidence/source but no `status` ⇒ treat as filled)
//   failed  → { status:'failed', error, at }   (no value in data[columnKey])
//   absent  ⇒ never run (empty)

/** A Dogi cell that produced a value — has provenance. */
export interface CellFilled {
  status?: 'filled';
  confidence: number;
  source: string | null;
  provider?: string | null;
  model?: string | null;
}

/** A Dogi cell whose last run failed — no value, carries the reason. */
export interface CellFailed {
  status: 'failed';
  /** Human-readable failure reason to surface in the cell peek / tooltip. */
  error: string;
  /** ISO timestamp of when the failure was recorded. */
  at?: string;
}

/** Per-cell enrichment state, keyed by column key. */
export type CellConf = CellFilled | CellFailed;

/** A cell conf is "failed" only when it explicitly carries status:'failed'. */
export function isCellFailed(conf: CellConf | undefined): conf is CellFailed {
  return conf?.status === 'failed';
}

// ── Domain shapes (mirror the API responses we actually render) ───────────────
export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  title: string | null;
  enrichmentStatus: string;
  enrichmentConf: Record<string, CellConf>;
  validationStatus: string;
  approvalStatus: string;
  sendStatus: string;
  subject: string | null;
  body: string | null;
  campaignId: string | null;
  repliedAt: string | null;
  bouncedAt: string | null;
  data: Record<string, unknown>;
  /** edit overrides set by user (Clay-style) */
  editedKeys?: string[];
  /** display order position */
  position?: number;
  createdAt: string;
}

/** Value type for typed column validation */
export type ValueType = 'text' | 'email' | 'url' | 'number' | 'date' | 'select' | 'checkbox';

/** Fill method determining how cells are populated */
export type FillMethod = 'manual' | 'dogi' | 'formula';

// ── Dogi config sub-types ────────────────────────────────────────────────────

export type DogiOutputMode = 'fill' | 'create' | 'map';

export interface DogiOutput {
  mode: DogiOutputMode;
  key?: string;
  label?: string;
}

export type DataProviderName = 'apollo' | 'hunter';
export type WebSearchVia = 'native' | 'external';

export type DogiSource =
  | { type: 'provider'; name: DataProviderName }
  | { type: 'web'; via: WebSearchVia }
  | { type: 'scrape'; via: 'firecrawl' }
  | { type: 'llm' };

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'grok';
export type KeySource = 'env' | 'byok';

export interface DogiBrain {
  provider: LLMProvider;
  model: string;
  keySource: KeySource;
}

/** Full column config — union of all column type configs */
export interface ColumnConfig {
  valueType?: ValueType;
  fillMethod?: FillMethod;
  options?: string[];          // select type
  expr?: string;               // formula type
  // Dogi-specific fields
  instruction?: string;
  reads?: string[];
  output?: DogiOutput;
  sources?: DogiSource[];
  policy?: 'combine' | 'first';
  brain?: DogiBrain;
  [key: string]: unknown;
}

export interface Column {
  id: string;
  key: string;
  label: string;
  type: 'enrichment' | 'agent' | 'formula' | 'manual' | 'dogi';
  config: ColumnConfig & { protected?: boolean };
  /** display order position */
  position?: number;
  /** column width in pixels */
  width?: number;
}

export interface CellJob {
  leadId: string;
  columnKey: string;
  status: 'queued' | 'running' | 'error';
  error?: string | null;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  leadId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  provider: string;
  status: string;
  createdAt: string;
}

export interface Table {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  leadCount: number;
  columnCount: number;
  createdAt: string;
  updatedAt?: string;
  settings?: { protected?: boolean };
}

// ── Phase G: Dedupe ──────────────────────────────────────────────────────────

/** Preview of how many rows a dedupe over `keys` would merge away. */
export interface DuplicatesPreview {
  keys: string[];
  /** Number of duplicate-value clusters. */
  groups: number;
  /** How many rows would be merged away (collapsed into their oldest match). */
  rows: number;
}

/** Result of performing a dedupe over `keys`. */
export interface DedupeResult {
  /** Number of duplicate-value clusters that were collapsed. */
  groups: number;
  /** How many rows were merged away. */
  merged: number;
  /** How many rows remain (the oldest match of each cluster). */
  kept: number;
}

export const tablesApi = {
  /** Preview duplicates for a set of key columns (read-only). */
  duplicates: (tableId: string, keys: string[]) =>
    api.get<DuplicatesPreview>(
      `/tables/${tableId}/duplicates?keys=${encodeURIComponent(keys.join(','))}`,
    ),

  /** Dedupe the table by a set of key columns — merges duplicates into oldest match. */
  dedupe: (tableId: string, keys: string[]) =>
    api.post<DedupeResult>(`/tables/${tableId}/dedupe`, { keys }),
};

// ── Lead-level run actions (Phase J · Round 2) ────────────────────────────────

export const leadsApi = {
  /**
   * Re-run a single Dogi cell — `POST /leads/:id/run/:columnKey`.
   * `apiKey` is forwarded for BYOK columns (session only, never persisted).
   */
  rerunCell: (leadId: string, columnKey: string, apiKey?: string) =>
    api.post<void>(`/leads/${leadId}/run/${columnKey}`, apiKey ? { apiKey } : undefined),

  /**
   * Re-run every Dogi column for one lead — `POST /leads/:id/run`.
   * Pass `{ force: true }` to re-run cells that already have a value, otherwise
   * only empty/failed cells are re-run.
   */
  rerunRow: (leadId: string, force?: boolean) =>
    api.post<void>(`/leads/${leadId}/run`, force ? { force } : undefined),
};

// ── Dogi goal-mode (Phase D) ─────────────────────────────────────────────────

/** One step in a Dogi plan — mirrors the dogi-agent.md §9 schema. */
export interface DogiPlanStep {
  id: string;
  label: string;
  instruction: string;
  reads: string[];
  output: {
    mode: 'create';
    key: string;
    label?: string;
  };
  sources: DogiSource[];
  policy: 'combine' | 'first';
  dependsOn: string[];
}

/** A structured plan returned by `POST /tables/:id/ask-dogi`. */
export interface DogiPlan {
  goal: string;
  steps: DogiPlanStep[];
}

/** Response from `POST /tables/:id/ask-dogi`. */
export interface AskDogiResponse {
  plan: DogiPlan | null;
  /** Friendly explanation if plan is null (e.g. no LLM configured). */
  reason?: string;
}

/** Response from `POST /tables/:id/apply-plan`. */
export interface ApplyPlanResponse {
  columnsCreated: number;
  jobsEnqueued: number;
}

export const dogiApi = {
  /** Ask Dogi to plan steps for a free-text goal. */
  askDogi: (tableId: string, goal: string) =>
    api.post<AskDogiResponse>(`/tables/${tableId}/ask-dogi`, { goal }),

  /** Approve a plan — creates the columns and starts running them. */
  applyPlan: (tableId: string, steps: DogiPlanStep[]) =>
    api.post<ApplyPlanResponse>(`/tables/${tableId}/apply-plan`, { steps }),
};

// ── Doggo goal-mode (row-sourcing + columns) ──────────────────────────────────
// Doggo is a superset of the Dogi planner: a plan step is EITHER a row-sourcing
// step (CREATE rows) or a column step (today's DogiPlanStep). See devx/doggo.md.

/** A step that CREATES rows — generate `count` entities and insert them as leads. */
export interface SourceRowsStep {
  kind: 'source-rows';
  /** Plain-language description of the entities to create ("top 10 EV companies"). */
  description: string;
  /** Target number of entities (clamped to [1, 50] at run time). */
  count: number;
  /** The object key each generated entity carries (snake_case, e.g. "company"). */
  primaryField: string;
  /** Human label for that field's column. */
  primaryLabel: string;
}

/** A column step is today's DogiPlanStep, optionally tagged with `kind: 'column'`. */
export type ColumnPlanStep = DogiPlanStep & { kind?: 'column' };

/** One Doggo plan step: create rows, or build/enrich a column. */
export type DoggoPlanStep = SourceRowsStep | ColumnPlanStep;

/** A structured plan returned by `POST /tables/:id/doggo/plan`. */
export interface DoggoPlan {
  goal: string;
  steps: DoggoPlanStep[];
}

/** A step with no `kind` is a legacy column step (back-compat). */
export function isSourceRowsStep(step: DoggoPlanStep): step is SourceRowsStep {
  return (step as { kind?: string }).kind === 'source-rows';
}

/** Response from `POST /tables/:id/doggo/plan`. */
export interface DoggoPlanResponse {
  plan: DoggoPlan | null;
  /** Friendly explanation if plan is null (e.g. no LLM configured). */
  reason?: string;
}

/** Response from `POST /tables/:id/doggo/run`. */
export interface DoggoRunResponse {
  rowsCreated: number;
  columnsCreated: number;
  enqueued: number;
}

export const doggoApi = {
  /** Ask Doggo to plan steps (row-sourcing + columns) for a free-text goal. */
  plan: (tableId: string, goal: string, apiKey?: string) =>
    api.post<DoggoPlanResponse>(`/tables/${tableId}/doggo/plan`, { goal, apiKey }),

  /** Run an approved Doggo plan — sources rows, builds columns, enqueues runs. */
  run: (tableId: string, plan: DoggoPlan, apiKey?: string) =>
    api.post<DoggoRunResponse>(`/tables/${tableId}/doggo/run`, { plan, apiKey }),
};

// ── Per-table Doggo settings (persisted in table.settings.doggo) ──────────────

/** Doggo's configurable settings, persisted in `table.settings.doggo`. */
export interface DoggoSettings {
  /** The brain (provider/model/keySource) Doggo's planner + created columns use. */
  brain?: DogiBrain;
  /** Default sources Doggo hands the columns it builds. */
  defaultSources?: DogiSource[];
}

/** Read one table's full row (incl. `settings`) from the list endpoint —
 *  there is no single-table GET route, so we filter the list by id. */
async function fetchTableRow(
  tableId: string,
): Promise<{ settings?: Record<string, unknown> } | undefined> {
  const { tables } = await api.get<{
    tables: { id: string; settings?: Record<string, unknown> }[];
  }>('/tables');
  return tables.find((t) => t.id === tableId);
}

export const doggoSettingsApi = {
  /** Read a table's persisted Doggo settings (empty object if unset). */
  async get(tableId: string): Promise<DoggoSettings> {
    const row = await fetchTableRow(tableId);
    return ((row?.settings?.doggo as DoggoSettings | undefined) ?? {});
  },

  /** Persist a table's Doggo settings, merging into existing `settings`. */
  async save(tableId: string, doggo: DoggoSettings): Promise<void> {
    const row = await fetchTableRow(tableId);
    const settings = { ...(row?.settings ?? {}), doggo };
    await api.patch(`/tables/${tableId}`, { settings });
  },
};

// ── Phase E: Saved agents ─────────────────────────────────────────────────────

/** A saved Dogi or goal-plan stored in the agents table. */
export interface SavedAgent {
  id: string;
  name: string;
  kind: 'dogi' | 'dogi-plan';
  config: Record<string, unknown>;
  createdAt: string;
}

export const agentsApi = {
  /** List all saved agents. */
  list: () => api.get<{ agents: SavedAgent[] }>('/agents'),

  /** Save a new agent. */
  save: (name: string, kind: 'dogi' | 'dogi-plan', config: Record<string, unknown>) =>
    api.post<{ agent: SavedAgent }>('/agents', { name, kind, config }),

  /** Delete a saved agent by id. */
  delete: (id: string) => api.del<void>(`/agents/${id}`),
};

// ── Settings: model + key status (read-only) ──────────────────────────────────

/** Which integration keys the server has configured (in its .env). All booleans. */
export interface KeyStatus {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  grok: boolean;
  apollo: boolean;
  hunter: boolean;
  findymail: boolean;
  dropcontact: boolean;
  serper: boolean;
  firecrawl: boolean;
  instantly: boolean;
  smartlead: boolean;
  smtp: boolean;
}

/** Response from `GET /settings`. */
export interface Settings {
  llm: { provider: string; model: string };
  keys: KeyStatus;
}

export const settingsApi = {
  /** Read the server's default model and which integration keys are configured. */
  get: () => api.get<Settings>('/settings'),
};

// ── Phase G.2c: Activity log (over audit_log) ─────────────────────────────────

/** One row of the workspace-wide activity feed, projected from `audit_log`. */
export interface AuditRow {
  id: string;
  /** Who performed the action — a user, "dogi", "doggo", or "system". */
  actor: string;
  /** The entity type touched, e.g. "lead", "column", "table". */
  entity: string;
  /** The id of the touched entity. */
  entityId: string;
  /** What happened — create / update / delete / send / merge / run … */
  action: string;
  /** Optional structured detail (e.g. the field changed, before/after). */
  diff: Record<string, unknown> | null;
  createdAt: string;
}

export const activityApi = {
  /** List workspace activity, newest first. `total` is the full count for paging. */
  list: (limit = 50, offset = 0) =>
    api.get<{ activity: AuditRow[]; total: number }>(
      `/activity?limit=${limit}&offset=${offset}`,
    ),
};

// ── Phase E: Cost estimate ────────────────────────────────────────────────────

export interface CostEstimate {
  perRow: number;
  total: number;
  breakdown: Record<string, number>;
}

/** Estimate cost before running a Dogi column. */
export function estimateCost(opts: {
  provider: string;
  model: string;
  rows: number;
  webSearch?: boolean;
}): Promise<CostEstimate> {
  return api.post<CostEstimate>('/estimate-cost', opts);
}
