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

/** Shared output contract — every Dogi run returns this single JSON object. */
const OUTPUT_CONTRACT = `Reply with a SINGLE JSON object and nothing else:
{ "value": <the value, or null>,
  "confidence": <0..1 how sure you are>,
  "source": "<the URL you got it from, or null>" }`;

/**
 * Research prompt — used when the run has real tools (web/scrape) or native web
 * search. Here a wrong fact is worse than no fact, so refusing to guess is right.
 */
const SYSTEM_RESEARCH = `You are Dogi, a precise B2B research agent inside Fetch.
Find ONE specific field for a lead using the tools available.
${OUTPUT_CONTRACT}
Never guess. If you cannot find it, return value null with low confidence.`;

/**
 * Transform prompt — used for pure-LLM columns (no tools). This is a generation
 * task (summarize / classify / rewrite / derive) over the given lead context,
 * NOT a fact lookup, so the model should produce a value rather than refuse.
 */
const SYSTEM_TRANSFORM = `You are Dogi, a helpful column agent inside Fetch.
Produce ONE field for a lead by transforming the lead context you are given
(summarize, classify, rewrite, format, or derive from existing columns).
${OUTPUT_CONTRACT}
Work only from the provided context — do not invent external facts. Return value
null only when the context genuinely lacks what you need.`;

/**
 * The lead's `data` keys we never feed the model — internal/huge blobs that would
 * just bloat the prompt without anchoring the answer.
 */
const CONTEXT_OMIT = new Set(['provenance', '_provenance', 'raw', '__raw']);

/**
 * Build the JSON context a Dogi sees for one lead. A Fetch table is arbitrary
 * columns, so the model must see the row's ACTUAL columns (`lead.data`) — not a
 * fixed identity shape. With no anchor (e.g. only a `company` cell) the model
 * free-associates and hallucinates; surfacing the row's own columns fixes that.
 *
 * We merge: the canonical identity fields (where present, for sending/dedupe
 * parlance) PLUS every value in `lead.data` (the table's real columns). The
 * `reads` allow-list, when given, scopes/orders which `data` keys to include;
 * with no `reads` we include all of `data` so context is never empty. Internal
 * blobs (provenance/raw) are omitted to keep the prompt sane.
 */
export function leadContext(lead: Lead, reads?: string[]): string {
  const data = (lead.data as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {};

  // Canonical identity first — only when present, so an arbitrary row isn't
  // padded with a wall of nulls.
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  if (name) base.name = name;
  if (lead.email) {
    base.email = lead.email;
    base.company_domain = lead.email.split('@')[1] ?? null;
  }
  if (lead.title) base.title = lead.title;
  if (lead.linkedinUrl) base.linkedin = lead.linkedinUrl;

  // The row's real columns. A non-empty `reads` scopes/orders which keys we
  // surface; with no `reads` we include EVERY data column so the model always
  // has the table's anchor (company, etc.), even for columns not in `reads`.
  const keys = reads && reads.length > 0 ? reads : Object.keys(data);
  for (const key of keys) {
    if (CONTEXT_OMIT.has(key)) continue;
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
  const isResearch = Boolean(opts.tools?.length || opts.webSearch);
  const maxSteps = opts.tools?.length ? (config.maxSteps ?? 6) : 1;
  const messages: LLMMessage[] = [
    { role: 'system', content: isResearch ? SYSTEM_RESEARCH : SYSTEM_TRANSFORM },
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
      // Replay the assistant turn WITH the calls it made — providers need the
      // tool_calls on this message so the tool results below have a parent to
      // reference (else OpenAI/Grok 400 on the orphaned `tool` message).
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
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
