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

export interface Column {
  id: string;
  key: string;
  label: string;
  type: 'enrichment' | 'agent' | 'formula' | 'manual' | 'dogi';
  config: {
    valueType?: ValueType;
    fillMethod?: FillMethod;
    options?: string[];        // for select type
    instruction?: string;      // for dogi type
    reads?: string[];          // for dogi type
    [key: string]: unknown;
  };
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
}
