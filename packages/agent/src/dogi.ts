import type { Lead } from '@fetch/db';
import { logger } from '@fetch/core';
import { getLLM, type GetLLMOptions, type LLMClient, type LLMMessage } from '@fetch/llm';
import { singleProviderWaterfall, type Waterfall } from '@fetch/enrichment';
import { scrapeUrl } from './tools/scrapeUrl';
import { webSearch } from './tools/webSearch';
import type { Tool } from './tools';

/**
 * Dogi — the generalized cell agent. A Dogi runs the enabled `sources` for one
 * field under a `policy`:
 *
 *   combine → run EVERY enabled source and merge into the richest answer.
 *   first   → try sources in order, STOP at the first confident value.
 *
 * Sources:
 *   provider     → one named data provider (enrichment waterfall, no LLM).
 *   web/native   → the LLM's OWN web search (needs a brain).
 *   web/external → our Serper tool inside the LLM research loop (needs a brain).
 *   scrape       → our Firecrawl tool inside the LLM research loop (needs a brain).
 *   llm          → pure reason/transform over `reads` (needs a brain).
 *
 * If no source needs an LLM (e.g. providers-only) and there's no brain, NO LLM
 * call is made. Output is always structured `{ value, confidence, source,
 * provider }`, never prose. Bounded by `maxSteps`.
 */

export type DogiSource =
  | { type: 'provider'; name: string }
  | { type: 'web'; via: 'native' | 'external' }
  | { type: 'scrape'; via: 'firecrawl' }
  | { type: 'llm' };

export interface DogiBrain {
  provider?: 'anthropic' | 'openai' | 'gemini' | 'grok';
  model?: string;
  keySource?: 'env' | 'byok';
}

export interface DogiConfig {
  instruction: string;
  reads?: string[];
  sources?: DogiSource[];
  policy?: 'combine' | 'first';
  brain?: DogiBrain;
  maxSteps?: number;
}

export interface DogiResult {
  value: unknown;
  confidence: number;
  source: string | null;
  provider: string;
}

export interface DogiRunContext {
  /** Field/key the Dogi must fill (the output key). */
  field: string;
  lead: Lead;
  /** BYOK key for this run; used when the brain's keySource is 'byok'. */
  apiKey?: string;
  /** Injectable waterfall factory + tools, for tests. */
  waterfallFor?: (name: string) => Waterfall | null;
  tools?: { webSearch: Tool; scrapeUrl: Tool };
}

/** A value is "confident" enough to stop the `first` policy at. */
const CONFIDENCE_FLOOR = 0.5;

const SYSTEM = `You are Dogi, a precise B2B research agent inside Fetch.
Find ONE specific field for a lead and return it as structured data.
When you have the answer, reply with a SINGLE JSON object and nothing else:
{ "value": <the value, or null if truly not found>,
  "confidence": <0..1 how sure you are>,
  "source": "<the URL you got it from, or null>" }
Never guess. If you cannot find it, return value null with low confidence.`;

function leadContext(lead: Lead, reads?: string[]): string {
  const data = (lead.data as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
    email: lead.email,
    title: lead.title,
    company_domain: lead.email?.split('@')[1] ?? null,
    linkedin: lead.linkedinUrl,
  };
  // Surface only the columns the Dogi is allowed to read (plus the base identity).
  for (const key of reads ?? []) {
    if (key in data) base[key] = data[key];
  }
  return JSON.stringify(base);
}

/** Does this config require an LLM at all? (provider-only Dogis don't.) */
export function needsLLM(config: DogiConfig): boolean {
  return (config.sources ?? []).some((s) => s.type !== 'provider');
}

/**
 * Resolve the LLM for a Dogi run, honoring the brain's provider/model and BYOK.
 * Returns null when no LLM is configured (caller degrades gracefully).
 */
function resolveBrain(config: DogiConfig, ctx: DogiRunContext): LLMClient | null {
  const brain = config.brain;
  const opts: GetLLMOptions = {};
  if (brain?.provider) opts.provider = brain.provider;
  if (brain?.model) opts.model = brain.model;
  // BYOK key only when the brain asks for it; otherwise env.
  if (brain?.keySource === 'byok' && ctx.apiKey) opts.apiKey = ctx.apiKey;
  return getLLM(opts);
}

/**
 * Run one data-provider source. Returns a structured result or null on a miss.
 */
async function runProviderSource(
  name: string,
  ctx: DogiRunContext,
): Promise<DogiResult | null> {
  const make = ctx.waterfallFor ?? singleProviderWaterfall;
  const wf = make(name);
  if (!wf) return null; // unknown or unconfigured provider — skip gracefully
  const hit = await wf.run(ctx.field, ctx.lead);
  if (!hit) return null;
  return { value: hit.value, confidence: hit.confidence, source: hit.source, provider: hit.provider };
}

/**
 * Run an LLM source: a research loop when `tools` are given (external web /
 * scrape), native provider search when `webSearch` is set, or a pure transform
 * when neither. Returns a structured result or null when nothing was found.
 */
async function runLLMSource(
  llm: LLMClient,
  config: DogiConfig,
  ctx: DogiRunContext,
  opts: { tools?: Tool[]; webSearch?: 'native'; providerTag: string },
): Promise<DogiResult | null> {
  const maxSteps = opts.tools?.length ? (config.maxSteps ?? 6) : 1;
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${config.instruction}\n\nField to return: ${ctx.field}\n\nLead context:\n${leadContext(
        ctx.lead,
        config.reads,
      )}`,
    },
  ];

  const tmap = new Map((opts.tools ?? []).map((t) => [t.def.name, t]));

  for (let step = 0; step < maxSteps; step++) {
    const res = await llm.chat({
      messages,
      tools: opts.tools?.map((t) => t.def),
      webSearch: opts.webSearch,
      maxTokens: 1024,
    });

    if (res.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: res.text || '(calling tools)' });
      for (const call of res.toolCalls) {
        const tool = tmap.get(call.name);
        const output = tool
          ? await tool.execute(call.input).catch((e) => `tool error: ${String(e)}`)
          : `unknown tool: ${call.name}`;
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
      continue;
    }

    const parsed = parseResult(res.text);
    if (parsed) {
      return { ...parsed, provider: opts.providerTag };
    }
    messages.push({
      role: 'user',
      content: 'Reply with ONLY the JSON object described in the instructions.',
    });
  }
  return null;
}

/**
 * Execute a single source, dispatching by type. Provider sources never touch
 * the LLM; the rest require a resolved brain (null when unavailable → skip).
 */
async function runSource(
  src: DogiSource,
  config: DogiConfig,
  ctx: DogiRunContext,
  llm: LLMClient | null,
): Promise<DogiResult | null> {
  const tools = ctx.tools ?? { webSearch, scrapeUrl };
  switch (src.type) {
    case 'provider':
      return runProviderSource(src.name, ctx);
    case 'web':
      if (!llm) return null;
      return src.via === 'native'
        ? runLLMSource(llm, config, ctx, { webSearch: 'native', providerTag: 'web:native' })
        : runLLMSource(llm, config, ctx, { tools: [tools.webSearch], providerTag: 'web:external' });
    case 'scrape':
      if (!llm) return null;
      return runLLMSource(llm, config, ctx, {
        tools: [tools.scrapeUrl, tools.webSearch],
        providerTag: 'scrape',
      });
    case 'llm':
      if (!llm) return null;
      return runLLMSource(llm, config, ctx, { providerTag: 'llm' });
    default:
      return null;
  }
}

/**
 * Run a Dogi for one field on one lead. The default sources (when the config
 * lists none) are a single LLM transform — the cheapest useful behaviour.
 */
export async function runDogi(config: DogiConfig, ctx: DogiRunContext): Promise<DogiResult | null> {
  const log = logger.child({ lead_id: ctx.lead.id, field: ctx.field });
  const sources: DogiSource[] =
    config.sources && config.sources.length > 0 ? config.sources : [{ type: 'llm' }];
  const policy = config.policy ?? 'combine';

  // Resolve the brain ONCE, and only if a source needs it — a providers-only
  // Dogi makes no LLM call at all.
  const llm = needsLLM({ ...config, sources }) ? resolveBrain(config, ctx) : null;

  const results: DogiResult[] = [];
  for (const src of sources) {
    let res: DogiResult | null = null;
    try {
      res = await runSource(src, config, ctx, llm);
    } catch (err) {
      // A source failure is a miss, never fatal — try the next one.
      log.warn('dogi source failed, continuing', { source: src.type, err: String(err) });
    }
    if (res && res.value !== null && res.value !== undefined && res.value !== '') {
      results.push(res);
      // `first` stops at the first CONFIDENT value; a shaky guess moves on.
      if (policy === 'first' && res.confidence >= CONFIDENCE_FLOOR) {
        log.info('dogi first-policy resolved', { source: src.type, confidence: res.confidence });
        return res;
      }
    }
  }

  if (results.length === 0) return null;
  // combine (or `first` that never cleared the floor) → keep the most confident.
  return mergeResults(results);
}

/** Merge: pick the highest-confidence result; tag the source list it agreed on. */
function mergeResults(results: DogiResult[]): DogiResult {
  const best = results.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const providers = [...new Set(results.map((r) => r.provider))];
  return { ...best, provider: providers.length > 1 ? providers.join('+') : best.provider };
}

/** Extract the single JSON object from the model's final message. */
function parseResult(
  text: string,
): { value: unknown; confidence: number; source: string | null } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return {
      value: obj.value ?? null,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
      source: obj.source ?? null,
    };
  } catch {
    return null;
  }
}
