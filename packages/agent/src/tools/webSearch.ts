import { getEnv } from '@fetch/core';
import type { Tool } from './types';

/**
 * web_search — Serper (Google) search. Returns the top organic results as
 * compact JSON the model can reason over. Degrades to a clear message when no
 * SERPER_API_KEY is set, so the loop still runs (it just has fewer tools).
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
    const key = getEnv().SERPER_API_KEY;
    const query = String(input.query ?? '');
    if (!key) return 'web_search unavailable: SERPER_API_KEY not configured.';

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) return `web_search error ${res.status}`;

    const data = (await res.json()) as any;
    const results = (data.organic ?? []).slice(0, 5).map((r: any) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));
    return JSON.stringify(results);
  },
};
