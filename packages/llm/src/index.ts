import { getEnv } from '@fetch/core';
import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';
import { GeminiClient } from './gemini';
import { GrokClient } from './grok';
import type { LLMClient } from './types';

export * from './types';
export * from './pricing';
export { AnthropicClient } from './anthropic';
export { OpenAIClient } from './openai';
export { GeminiClient } from './gemini';
export { GrokClient } from './grok';

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'grok';

/** Default model per provider when the caller doesn't pin one. */
const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4.1',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4',
};

export interface GetLLMOptions {
  /** Which provider to build. Defaults to env `LLM_PROVIDER`. */
  provider?: LLMProvider;
  /** Model id. Defaults to env `LLM_MODEL` (for the env provider) or a per-provider default. */
  model?: string;
  /**
   * BYOK key override for this run. When present it is used INSTEAD of the env
   * key — it rides on the request only and is never persisted or logged.
   */
  apiKey?: string;
}

// We cache only the zero-arg env client; BYOK / explicit-provider calls build a
// fresh client each time so a caller-supplied key never leaks into the cache.
let cached: LLMClient | null = null;

function build(provider: LLMProvider, model: string, apiKey: string): LLMClient {
  switch (provider) {
    case 'openai':
      return new OpenAIClient(apiKey, model);
    case 'gemini':
      return new GeminiClient(apiKey, model);
    case 'grok':
      return new GrokClient(apiKey, model);
    case 'anthropic':
    default:
      return new AnthropicClient(apiKey, model);
  }
}

/** The env key for a provider, or undefined when unconfigured. */
function envKey(provider: LLMProvider): string | undefined {
  const env = getEnv();
  switch (provider) {
    case 'openai':
      return env.OPENAI_API_KEY;
    case 'gemini':
      return env.GEMINI_API_KEY;
    case 'grok':
      return env.GROK_API_KEY;
    case 'anthropic':
    default:
      return env.ANTHROPIC_API_KEY;
  }
}

/**
 * Build an LLM client across all four providers (Anthropic, OpenAI, Gemini,
 * Grok), or return null when it can't be configured — callers treat null as
 * "the AI path is unavailable" and degrade gracefully (a providers-only Dogi
 * never calls this).
 *
 * Key resolution: a per-call `apiKey` (BYOK) is used as-is; otherwise the env
 * key for the chosen provider. With no options it returns the cached env client.
 */
export function getLLM(opts: GetLLMOptions = {}): LLMClient | null {
  const env = getEnv();
  const provider = (opts.provider ?? env.LLM_PROVIDER) as LLMProvider;

  // The model defaults to env LLM_MODEL only when using the env-default provider;
  // an explicitly chosen provider gets that provider's sensible default instead.
  const usingEnvProvider = !opts.provider || opts.provider === env.LLM_PROVIDER;
  const model =
    opts.model ?? (usingEnvProvider ? env.LLM_MODEL : DEFAULT_MODELS[provider]);

  // BYOK: build fresh, never cache a caller key.
  if (opts.apiKey) return build(provider, model, opts.apiKey);

  const key = envKey(provider);
  if (!key) return null;

  // Cache only the plain zero-arg env client.
  const isDefaultCall = !opts.provider && !opts.model;
  if (isDefaultCall && cached) return cached;
  const client = build(provider, model, key);
  if (isDefaultCall) cached = client;
  return client;
}

/** Like getLLM but throws when unavailable — for code paths that require AI. */
export function requireLLM(opts: GetLLMOptions = {}): LLMClient {
  const llm = getLLM(opts);
  if (!llm) {
    throw new Error(
      'No LLM configured. Set LLM_PROVIDER and the matching API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GROK_API_KEY), or pass a BYOK key.',
    );
  }
  return llm;
}
