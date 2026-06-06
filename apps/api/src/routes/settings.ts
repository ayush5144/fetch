import { Hono } from 'hono';
import { getEnv } from '@fetch/core';

/**
 * GET /settings — a read-only report of which provider keys the server has
 * configured, for the self-host Settings page. It exposes ONLY booleans
 * (presence), never any key value, and never logs env contents. A key counts as
 * present when its env var is set and non-empty after trimming.
 */
export const settingsRoutes = new Hono();

/** True when an env var is set and non-empty (trimmed). Presence only. */
function has(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

settingsRoutes.get('/', (c) => {
  // getEnv() applies the codebase defaults: LLM_PROVIDER -> 'anthropic',
  // LLM_MODEL -> 'claude-opus-4-8'.
  const env = getEnv();

  return c.json({
    llm: {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
    },
    keys: {
      anthropic: has('ANTHROPIC_API_KEY'),
      openai: has('OPENAI_API_KEY'),
      gemini: has('GEMINI_API_KEY'),
      grok: has('GROK_API_KEY'),
      apollo: has('APOLLO_API_KEY'),
      hunter: has('HUNTER_API_KEY'),
      findymail: has('FINDYMAIL_API_KEY'),
      dropcontact: has('DROPCONTACT_API_KEY'),
      serper: has('SERPER_API_KEY'),
      firecrawl: has('FIRECRAWL_API_KEY'),
      instantly: has('INSTANTLY_API_KEY'),
      smartlead: has('SMARTLEAD_API_KEY'),
      smtp: has('SMTP_HOST'),
    },
    // Web search + scrape backend availability (presence only). The UI gates the
    // per-Dogi web/scrape toggles on these and shows which backend is in use.
    search: {
      // Self-hosted OpenSERP is configured (preferred web-search backend).
      openserp: has('OPENSERP_URL'),
      // Hosted Serper key present (web-search fallback).
      serper: has('SERPER_API_KEY'),
      // Self-hosted Firecrawl URL configured (preferred scrape backend).
      firecrawl_selfhosted: has('FIRECRAWL_API_URL'),
      // Hosted Firecrawl key present (scrape fallback).
      firecrawl: has('FIRECRAWL_API_KEY'),
    },
  });
});
