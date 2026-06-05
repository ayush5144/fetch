/**
 * MCP resources — the READ surface, exposed in addition to the read tools so a
 * client can pull Fetch context in directly. devx/mcp.md §2.1 lists these as
 * resources; we ship the four the brief calls for as resource templates:
 *
 *   fetch://tables                 → every table (id, name, counts)
 *   fetch://table/{id}/schema      → a table's columns
 *   fetch://table/{id}/rows        → a table's rows (with provenance)
 *   fetch://lead/{id}              → one lead (full record + provenance)
 *
 * Each just reads through the same FetchClient the tools use.
 */

import type { FetchClient } from './client.js';

/** A resource template advertised in resources/templates/list. */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'fetch://tables',
    name: 'tables',
    description: 'Every table in the workspace with id, name, and row/column counts.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'fetch://table/{id}/schema',
    name: 'table schema',
    description: "A table's columns (key, label, type, config).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'fetch://table/{id}/rows',
    name: 'table rows',
    description: "A table's rows (leads) with cell values and per-cell provenance.",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'fetch://lead/{id}',
    name: 'lead',
    description: "One lead's full record + per-cell provenance (confidence, source).",
    mimeType: 'application/json',
  },
];

/** `fetch://tables` is also offered as a concrete resource (no params). */
export const STATIC_RESOURCES = [
  {
    uri: 'fetch://tables',
    name: 'tables',
    description: 'Every table in the workspace with id, name, and row/column counts.',
    mimeType: 'application/json',
  },
];

/**
 * Resolve a `fetch://…` URI to its JSON content by calling the API. Throws
 * (FetchApiError or a clear Error) on an unknown URI or an API failure; the
 * server turns that into an MCP error.
 */
export async function readResource(
  client: FetchClient,
  uri: string,
): Promise<unknown> {
  if (uri === 'fetch://tables') {
    return client.get('/tables');
  }
  let m = uri.match(/^fetch:\/\/table\/([^/]+)\/schema$/);
  if (m) return client.get(`/tables/${m[1]}/columns`);

  m = uri.match(/^fetch:\/\/table\/([^/]+)\/rows$/);
  if (m) return client.get(`/tables/${m[1]}/leads`);

  m = uri.match(/^fetch:\/\/lead\/([^/]+)$/);
  if (m) return client.get(`/leads/${m[1]}`);

  throw new Error(
    `Unknown resource URI: ${uri}. Known: fetch://tables, fetch://table/{id}/schema, fetch://table/{id}/rows, fetch://lead/{id}.`,
  );
}
