import { getEnv } from '@fetch/core';
import type { Tool } from './types';

/** The normalized result row the tool returns (matches the Serper shape the
 *  agent loop has always seen). */
interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

const NUM_RESULTS = 5;

/**
 * web_search — returns the top organic results as compact JSON the model can
 * reason over. Backend is chosen by env at call time (graceful fallback):
 *
 *   1. OPENSERP_URL set → self-hosted OpenSERP (no key). Engine = OPENSERP_ENGINE
 *      || 'google'. GET {url}/{engine}/search?text=…&lang=EN&limit=N.
 *   2. else SERPER_API_KEY set → hosted Serper (Google).
 *   3. else → a clear "unavailable" message (the loop still runs with fewer
 *      tools).
 *
 * Either backend normalizes to the SAME {title, link, snippet}[] JSON, so the
 * research loop is unchanged regardless of which is wired.
 */
export const webSearch: Tool = {
  def: {
    name: 'web_search',
    description: 'Search the web for facts about a person or company. Returns top results.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    },
  },
  async execute(input) {
    const env = getEnv();
    const query = String(input.query ?? '');

    if (env.OPENSERP_URL) return searchOpenSerp(env.OPENSERP_URL, env.OPENSERP_ENGINE || 'google', query);
    if (env.SERPER_API_KEY) return searchSerper(env.SERPER_API_KEY, query);
    return 'web_search unavailable: no search backend configured (set OPENSERP_URL or SERPER_API_KEY).';
  },
};

/** OpenSERP: GET {base}/{engine}/search?text=…&lang=EN&limit=N → {results:[{title,url,snippet}]}. */
async function searchOpenSerp(base: string, engine: string, query: string): Promise<string> {
  const url = `${base.replace(/\/$/, '')}/${engine}/search?text=${encodeURIComponent(query)}&lang=EN&limit=${NUM_RESULTS}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return `web_search unavailable: could not reach OpenSERP at ${base} (${String(err)}).`;
  }
  if (!res.ok) return `web_search error ${res.status} from OpenSERP.`;

  const data = (await res.json()) as unknown;

  // OpenSERP signals failures (e.g. a CAPTCHA from a datacenter IP) as an error
  // object. Surface it as a clear, non-fatal tool message.
  if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
    return `web_search unavailable: OpenSERP (${engine}) returned an error: ${String((data as { error: unknown }).error)}.`;
  }

  const raw = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
  const results: SearchResult[] = (Array.isArray(raw) ? raw : [])
    .slice(0, NUM_RESULTS)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        title: String(row.title ?? ''),
        link: String(row.url ?? row.link ?? ''),
        snippet: String(row.snippet ?? row.description ?? ''),
      };
    })
    .filter((r) => r.link);

  if (results.length === 0) return `web_search: no results from OpenSERP (${engine}) for "${query}".`;
  return JSON.stringify(results);
}

/** Serper (hosted Google): POST → {organic:[{title,link,snippet}]}. */
async function searchSerper(key: string, query: string): Promise<string> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: NUM_RESULTS }),
  });
  if (!res.ok) return `web_search error ${res.status}`;

  const data = (await res.json()) as { organic?: unknown[] };
  const results: SearchResult[] = (data.organic ?? []).slice(0, NUM_RESULTS).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      title: String(row.title ?? ''),
      link: String(row.link ?? ''),
      snippet: String(row.snippet ?? ''),
    };
  });
  return JSON.stringify(results);
}
