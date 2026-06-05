/**
 * A tiny HTTP helper for talking to the Fetch REST API.
 *
 * The MCP server is a THIN ADAPTER: every action goes through the same HTTP API
 * the UI uses, so auth, gates, dedupe, audit, and provenance are reused. This
 * file never touches the DB and never reimplements business logic.
 *
 * Config (env):
 *   FETCH_API_URL   — base URL of the Fetch API (default http://localhost:4000)
 *   FETCH_API_TOKEN — optional bearer token; when set, sent as
 *                     `Authorization: Bearer <token>` on every request.
 *
 * Errors are surfaced with actionable messages (an agent reads them): the
 * method, path, HTTP status, and the API's own `error` field when present.
 */

export interface FetchClientOptions {
  /** Base URL of the Fetch API. Defaults to FETCH_API_URL or http://localhost:4000. */
  baseUrl?: string;
  /** Bearer token. Defaults to FETCH_API_TOKEN (optional). */
  token?: string;
  /** Injectable fetch (tests pass a mock); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thrown on a non-2xx API response; carries the status + parsed message. */
export class FetchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FetchApiError';
  }
}

const DEFAULT_BASE_URL = 'http://localhost:4000';

export class FetchClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FetchClientOptions = {}) {
    const base =
      opts.baseUrl ?? process.env.FETCH_API_URL ?? DEFAULT_BASE_URL;
    // Normalize: no trailing slash, so `${base}${path}` is always clean.
    this.baseUrl = base.replace(/\/+$/, '');
    this.token = opts.token ?? process.env.FETCH_API_TOKEN ?? undefined;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Headers for a request: JSON + bearer when a token is configured. */
  headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    // Best-effort actor hint. The API derives the audit actor itself today and
    // may ignore this; harmless when unsupported (see README "Audit").
    h['x-fetch-actor'] = 'mcp';
    return h;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure: the API is probably not running / unreachable.
      const reason = err instanceof Error ? err.message : String(err);
      throw new FetchApiError(
        `Could not reach the Fetch API at ${url} (${method}): ${reason}. ` +
          `Is the API running? Set FETCH_API_URL if it lives elsewhere.`,
        0,
      );
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text; // non-JSON body (e.g. an upstream proxy error page)
      }
    }

    if (!res.ok) {
      const apiMessage =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : typeof parsed === 'string' && parsed
            ? parsed
            : res.statusText;
      throw new FetchApiError(
        `${method} ${path} failed (HTTP ${res.status}): ${apiMessage}`,
        res.status,
      );
    }

    return parsed as T;
  }
}
