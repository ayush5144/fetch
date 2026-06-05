#!/usr/bin/env node
/**
 * Fetch MCP server (stdio transport).
 *
 * A THIN ADAPTER over the Fetch REST API — never a parallel brain. It exposes
 * Fetch's read primitives as both MCP tools AND resources, and (unless read-only)
 * the write primitives as tools. Every call goes through the HTTP API so auth,
 * gates, dedupe, audit, and provenance are reused.
 *
 * Env:
 *   FETCH_API_URL       base URL of the API (default http://localhost:4000)
 *   FETCH_API_TOKEN     optional bearer token (least privilege)
 *   FETCH_MCP_READONLY  "true" (default) → read tools only; "false" → + write tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { FetchClient } from './client.js';
import { buildToolRegistry, runTool } from './tools.js';
import {
  RESOURCE_TEMPLATES,
  STATIC_RESOURCES,
  readResource,
} from './resources.js';
import pkg from '../package.json' with { type: 'json' };

/** Read the read-only gate. Defaults to true (safe) unless explicitly "false". */
export function isReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FETCH_MCP_READONLY ?? 'true').toLowerCase() !== 'false';
}

export function createServer(opts?: { client?: FetchClient; readOnly?: boolean }) {
  const client = opts?.client ?? new FetchClient();
  const readOnly = opts?.readOnly ?? isReadOnly();
  const tools = buildToolRegistry({ client, readOnly });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'fetch', version: pkg.version },
    { capabilities: { tools: {}, resources: {} } },
  );

  // tools/list — advertise the registered tools (read-only hides write tools).
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchemaCompat(t.inputSchema) as {
        type: 'object';
        [k: string]: unknown;
      },
    })),
  }));

  // tools/call — dispatch; failures come back as isError, not thrown.
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const def = byName.get(req.params.name);
    if (!def) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const result = await runTool(def, req.params.arguments);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });

  // resources/list + resources/templates/list — the read surface as resources.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES,
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  // resources/read — resolve fetch://… to JSON via the API.
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const data = await readResource(client, uri);
    return {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
      ],
    };
  });

  return { server, tools, readOnly, client };
}

async function main(): Promise<void> {
  const { server, readOnly, client } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  process.stderr.write(
    `fetch MCP server up · api=${client.baseUrl} · mode=${readOnly ? 'read-only' : 'read-write'}\n`,
  );
}

// Run as a binary, but stay importable (tests import createServer/isReadOnly).
const isMain =
  process.argv[1] != null &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`fetch MCP server failed to start: ${err}\n`);
    process.exit(1);
  });
}
