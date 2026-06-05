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

// ── Domain shapes (mirror the API responses we actually render) ───────────────
export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  title: string | null;
  enrichmentStatus: string;
  enrichmentConf: Record<string, { confidence: number; source: string | null; model?: string | null }>;
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
