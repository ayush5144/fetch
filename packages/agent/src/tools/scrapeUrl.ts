import { getEnv } from '@fetch/core';
import type { Tool } from './types';

const MAX_CHARS = 8000;

/**
 * scrape_url — Firecrawl scrape. Fetches a page and returns its content as
 * markdown so the model can read it. Backend chosen by env (graceful fallback):
 *
 *   1. FIRECRAWL_API_URL set → self-hosted Firecrawl (no key required; a bearer
 *      is sent only if FIRECRAWL_API_KEY is ALSO set, for a secured self-host).
 *   2. else FIRECRAWL_API_KEY set → hosted Firecrawl.
 *   3. else → a clear "unavailable" message (non-fatal; the loop continues).
 *
 * Both backends speak the same /v1/scrape API and return data.markdown.
 */
export const scrapeUrl: Tool = {
  def: {
    name: 'scrape_url',
    description: 'Fetch a URL and return its readable content as markdown.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to scrape.' } },
      required: ['url'],
    },
  },
  async execute(input) {
    const env = getEnv();
    const url = String(input.url ?? '');

    if (env.FIRECRAWL_API_URL) {
      // Self-hosted: no key required; include the bearer only if one is set.
      return scrape(`${env.FIRECRAWL_API_URL.replace(/\/$/, '')}/v1/scrape`, url, env.FIRECRAWL_API_KEY, env.FIRECRAWL_API_URL);
    }
    if (env.FIRECRAWL_API_KEY) {
      return scrape('https://api.firecrawl.dev/v1/scrape', url, env.FIRECRAWL_API_KEY);
    }
    return 'scrape_url unavailable: no scrape backend configured (set FIRECRAWL_API_URL or FIRECRAWL_API_KEY).';
  },
};

/** POST {endpoint} {url, formats:['markdown']} → data.markdown (capped). */
async function scrape(endpoint: string, url: string, key: string | undefined, base?: string): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
  } catch (err) {
    const where = base ? ` at ${base}` : '';
    return `scrape_url unavailable: could not reach Firecrawl${where} (${String(err)}).`;
  }
  if (!res.ok) return `scrape_url error ${res.status}`;

  const data = (await res.json()) as { data?: { markdown?: string } };
  const markdown = data.data?.markdown ?? '';
  // Cap content so a huge page can't blow the context window or the cost ceiling.
  return markdown.slice(0, MAX_CHARS);
}
