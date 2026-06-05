import type { LLMProvider } from './index';

/**
 * Pricing + cost estimation (Phase E §4). A small static table of public list
 * prices per model — input/output USD per 1M tokens — plus a per-provider
 * web-search add-on (USD per 1k searches). `estimateCost` turns "run this Dogi
 * over N rows" into a dollar figure BEFORE firing, using a simple token
 * heuristic so the UI can warn on a big run.
 *
 * Prices are approximate list prices and easy to update; the estimate is a
 * guide, not a billing source of truth. See providers-and-keys.md §4.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

export interface ProviderPricing {
  /** USD per 1,000 native web searches. */
  webSearchPer1k: number;
  models: Record<string, ModelPricing>;
}

/**
 * Per-provider, per-model list pricing. A few representative models each. Keys
 * match the model ids the LLM clients accept (and the per-provider defaults in
 * index.ts).
 */
export const PRICING: Record<LLMProvider, ProviderPricing> = {
  anthropic: {
    webSearchPer1k: 10,
    models: {
      'claude-opus-4-8': { inputPerM: 15, outputPerM: 75 },
      'claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15 },
      'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
    },
  },
  openai: {
    webSearchPer1k: 10,
    models: {
      'gpt-5': { inputPerM: 1.25, outputPerM: 10 },
      'gpt-4.1': { inputPerM: 2, outputPerM: 8 },
      'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
    },
  },
  gemini: {
    webSearchPer1k: 14,
    models: {
      'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
      'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
      'gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
    },
  },
  grok: {
    webSearchPer1k: 25,
    models: {
      'grok-4': { inputPerM: 3, outputPerM: 15 },
      'grok-4-fast': { inputPerM: 0.2, outputPerM: 0.5 },
      'grok-3': { inputPerM: 3, outputPerM: 15 },
    },
  },
};

/** Rough per-row token heuristic (instruction + reads in, structured cell out). */
export const TOKENS_PER_ROW = { input: 500, output: 150 } as const;

export interface EstimateCostInput {
  provider: string;
  model: string;
  rows: number;
  /** Whether the Dogi uses native web search (adds the per-1k search cost). */
  webSearch?: boolean;
}

export interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  webSearchCost: number;
}

export interface CostEstimate {
  /** USD per row. */
  perRow: number;
  /** USD for all `rows`. */
  total: number;
  breakdown: CostBreakdown;
}

/** Look up pricing for a provider/model, or undefined if either is unknown. */
export function getModelPricing(
  provider: string,
  model: string,
): { provider: ProviderPricing; model: ModelPricing } | undefined {
  const p = PRICING[provider as LLMProvider];
  if (!p) return undefined;
  const m = p.models[model];
  if (!m) return undefined;
  return { provider: p, model: m };
}

/**
 * Estimate the cost of running a Dogi over `rows` rows. Throws on an unknown
 * provider or model (the route maps that to a 400). One web search per row is
 * assumed when `webSearch` is on.
 */
export function estimateCost(input: EstimateCostInput): CostEstimate {
  const found = getModelPricing(input.provider, input.model);
  if (!found) {
    throw new Error(`unknown provider/model: ${input.provider}/${input.model}`);
  }
  const rows = Math.max(0, Math.floor(input.rows));

  const inputTokens = rows * TOKENS_PER_ROW.input;
  const outputTokens = rows * TOKENS_PER_ROW.output;
  const inputCost = (inputTokens / 1_000_000) * found.model.inputPerM;
  const outputCost = (outputTokens / 1_000_000) * found.model.outputPerM;
  const webSearchCost = input.webSearch ? (rows / 1000) * found.provider.webSearchPer1k : 0;

  const total = inputCost + outputCost + webSearchCost;
  return {
    perRow: rows > 0 ? total / rows : 0,
    total,
    breakdown: { inputTokens, outputTokens, inputCost, outputCost, webSearchCost },
  };
}
