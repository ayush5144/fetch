import { getEnv, isConfigured } from '@fetch/core';
import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';
import type { LLMClient } from './types';

export * from './types';
export { AnthropicClient } from './anthropic';
export { OpenAIClient } from './openai';

let cached: LLMClient | null = null;

/**
 * Build the configured LLM client (Anthropic or OpenAI), or null when no key is
 * present. Callers treat null as "the AI path is unavailable" and degrade
 * gracefully — the system still boots and runs structured providers without it.
 */
export function getLLM(): LLMClient | null {
  if (cached) return cached;
  if (!isConfigured('llm')) return null;
  const env = getEnv();
  cached =
    env.LLM_PROVIDER === 'openai'
      ? new OpenAIClient(env.OPENAI_API_KEY!, env.LLM_MODEL)
      : new AnthropicClient(env.ANTHROPIC_API_KEY!, env.LLM_MODEL);
  return cached;
}

/** Like getLLM but throws when unavailable — for code paths that require AI. */
export function requireLLM(): LLMClient {
  const llm = getLLM();
  if (!llm) {
    throw new Error(
      'No LLM configured. Set LLM_PROVIDER and the matching API key (ANTHROPIC_API_KEY / OPENAI_API_KEY).',
    );
  }
  return llm;
}
