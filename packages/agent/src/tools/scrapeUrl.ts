import { getEnv } from '@fetch/core';
import type { Tool } from './types';

/**
 * scrape_url — Firecrawl scrape. Fetches a page and returns its content as
 * markdown so the model can read it. Used after web_search narrows to a source.
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
    const key = getEnv().FIRECRAWL_API_KEY;
    const url = String(input.url ?? '');
    if (!key) return 'scrape_url unavailable: FIRECRAWL_API_KEY not configured.';

    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
    if (!res.ok) return `scrape_url error ${res.status}`;

    const data = (await res.json()) as any;
    const markdown: string = data.data?.markdown ?? '';
    // Cap content so a huge page can't blow the context window or the cost ceiling.
    return markdown.slice(0, 8000);
  },
};
