import { describe, expect, it, vi } from 'vitest';
import { FetchClient } from '../src/client.js';
import { buildToolRegistry } from '../src/tools.js';
import { isReadOnly } from '../src/index.js';

/**
 * Pure, no-network tests for the MCP adapter:
 *  - read-only mode registers ONLY read tools (write tools never appear),
 *  - read-write mode adds the write tools,
 *  - the read-only gate defaults to true and only "false" flips it,
 *  - the HTTP client sends a bearer header iff FETCH_API_TOKEN is set.
 */

const READ_TOOLS = [
  'list_tables',
  'get_table_schema',
  'query_rows',
  'get_lead',
  'get_job',
  'recent_activity',
];

const WRITE_TOOLS = [
  'create_table',
  'create_column',
  'add_leads',
  'update_cell',
  'run_column',
  'run_cell',
  'dedupe',
  'ask_bone',
  'run_bone',
  'estimate_cost',
];

function names(readOnly: boolean): string[] {
  const client = new FetchClient({ baseUrl: 'http://example.test' });
  return buildToolRegistry({ client, readOnly }).map((t) => t.name);
}

describe('tool registry gating', () => {
  it('read-only mode registers only the read tools', () => {
    const n = names(true);
    expect(n.sort()).toEqual([...READ_TOOLS].sort());
    for (const w of WRITE_TOOLS) expect(n).not.toContain(w);
  });

  it('read-write mode adds the write tools', () => {
    const n = names(false);
    for (const r of READ_TOOLS) expect(n).toContain(r);
    for (const w of WRITE_TOOLS) expect(n).toContain(w);
    expect(n).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length);
  });

  it('every write tool is flagged write, every read tool is not', () => {
    const client = new FetchClient({ baseUrl: 'http://example.test' });
    const reg = buildToolRegistry({ client, readOnly: false });
    for (const t of reg) {
      if (WRITE_TOOLS.includes(t.name)) expect(t.write).toBe(true);
      if (READ_TOOLS.includes(t.name)) expect(t.write).toBe(false);
    }
  });
});

describe('read-only gate', () => {
  it('defaults to true when unset', () => {
    expect(isReadOnly({})).toBe(true);
  });
  it('stays true for "true" / any non-false value', () => {
    expect(isReadOnly({ FETCH_MCP_READONLY: 'true' })).toBe(true);
    expect(isReadOnly({ FETCH_MCP_READONLY: 'yes' })).toBe(true);
  });
  it('flips to false only for "false" (case-insensitive)', () => {
    expect(isReadOnly({ FETCH_MCP_READONLY: 'false' })).toBe(false);
    expect(isReadOnly({ FETCH_MCP_READONLY: 'FALSE' })).toBe(false);
  });
});

describe('FetchClient bearer header', () => {
  function mockFetch() {
    return vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  it('sends Authorization: Bearer when a token is set', async () => {
    const fetchImpl = mockFetch();
    const client = new FetchClient({
      baseUrl: 'http://example.test',
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get('/tables');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
  });

  it('omits Authorization when no token is set', async () => {
    const fetchImpl = mockFetch();
    const client = new FetchClient({
      baseUrl: 'http://example.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get('/tables');

    const init = fetchImpl.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('surfaces the API error message on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'a column with that name already exists' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new FetchClient({
      baseUrl: 'http://example.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.post('/tables/x/columns', {})).rejects.toThrow(
      /HTTP 409.*a column with that name already exists/,
    );
  });
});
