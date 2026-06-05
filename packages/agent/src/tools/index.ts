import { scrapeUrl } from './scrapeUrl';
import { webSearch } from './webSearch';
import type { Tool } from './types';

export type { Tool } from './types';
export { webSearch } from './webSearch';
export { scrapeUrl } from './scrapeUrl';

/**
 * The default toolset for the research loop. browser_action (Playwright, for
 * gated pages) is intentionally deferred — it's only needed for login-walled
 * sources and adds a heavy dependency, so it plugs in here when required.
 */
export const defaultTools: Tool[] = [webSearch, scrapeUrl];

export const toolMap = (tools: Tool[]): Map<string, Tool> =>
  new Map(tools.map((t) => [t.def.name, t]));
