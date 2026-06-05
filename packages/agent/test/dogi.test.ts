import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM layer so we can assert when (and how) the brain is resolved.
const { getLLM } = vi.hoisted(() => ({ getLLM: vi.fn() }));
vi.mock('@fetch/llm', () => ({ getLLM }));

import { runDogi, type DogiConfig, type DogiRunContext } from '../src/dogi';

/**
 * Phase C — the Dogi resolver. Pure unit tests with mocked sources + LLM:
 * proves providers-only makes NO LLM call, the combine/first policy, structured
 * output, and BYOK key resolution.
 */
const lead = { id: 'l1', email: 'ava@acme.com', firstName: 'Ava', data: {} } as any;

/** A fake waterfall whose run() returns a canned hit (or null). */
function fakeWaterfall(hit: { value: unknown; confidence: number; source: string | null; provider: string } | null) {
  return { run: vi.fn().mockResolvedValue(hit), activeProviders: [] } as any;
}

/** An LLM client whose chat() returns a fixed structured JSON answer. */
function fakeLLM(value: unknown, confidence: number, source: string | null) {
  return {
    provider: 'anthropic',
    model: 'x',
    chat: vi.fn().mockResolvedValue({
      text: JSON.stringify({ value, confidence, source }),
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end',
    }),
  };
}

afterEach(() => {
  getLLM.mockReset();
});

describe('runDogi', () => {
  it('providers-only makes NO LLM call', async () => {
    const config: DogiConfig = { instruction: 'find size', sources: [{ type: 'provider', name: 'apollo' }] };
    const ctx: DogiRunContext = {
      field: 'company_size',
      lead,
      waterfallFor: () => fakeWaterfall({ value: 240, confidence: 0.9, source: 'https://apollo', provider: 'apollo' }),
    };
    const res = await runDogi(config, ctx);
    expect(res?.value).toBe(240);
    expect(res?.provider).toBe('apollo');
    expect(getLLM).not.toHaveBeenCalled(); // no brain resolved for providers-only
  });

  it('runs the LLM source and returns structured output', async () => {
    getLLM.mockReturnValue(fakeLLM('ceo@acme.com', 0.8, 'https://acme.com'));
    const config: DogiConfig = { instruction: 'find email', sources: [{ type: 'llm' }] };
    const res = await runDogi(config, { field: 'ceo_email', lead });
    expect(res).toMatchObject({ value: 'ceo@acme.com', confidence: 0.8, source: 'https://acme.com' });
  });

  it('policy "first" stops at the first confident source', async () => {
    const providerHit = fakeWaterfall({ value: 'A', confidence: 0.9, source: null, provider: 'apollo' });
    const config: DogiConfig = {
      instruction: 'x',
      policy: 'first',
      sources: [{ type: 'provider', name: 'apollo' }, { type: 'llm' }],
    };
    const llmClient = fakeLLM('B', 0.95, null);
    getLLM.mockReturnValue(llmClient);
    const res = await runDogi(config, { field: 'f', lead, waterfallFor: () => providerHit });
    expect(res?.value).toBe('A'); // stopped at the first confident hit
    expect(llmClient.chat).not.toHaveBeenCalled(); // LLM source never actually ran
  });

  it('policy "combine" keeps the most confident across sources', async () => {
    const providerHit = fakeWaterfall({ value: 'A', confidence: 0.6, source: null, provider: 'apollo' });
    getLLM.mockReturnValue(fakeLLM('B', 0.95, 'https://b'));
    const config: DogiConfig = {
      instruction: 'x',
      policy: 'combine',
      sources: [{ type: 'provider', name: 'apollo' }, { type: 'llm' }],
    };
    const res = await runDogi(config, { field: 'f', lead, waterfallFor: () => providerHit });
    expect(res?.value).toBe('B'); // higher-confidence wins
    expect(res?.provider).toContain('+'); // merged provenance tag
  });

  it('uses a BYOK key when the brain asks for it', async () => {
    getLLM.mockReturnValue(fakeLLM('x', 0.9, null));
    const config: DogiConfig = {
      instruction: 'x',
      sources: [{ type: 'llm' }],
      brain: { provider: 'openai', keySource: 'byok' },
    };
    await runDogi(config, { field: 'f', lead, apiKey: 'sk-byok' });
    expect(getLLM).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', apiKey: 'sk-byok' }));
  });

  it('returns null when nothing is found', async () => {
    const config: DogiConfig = { instruction: 'x', sources: [{ type: 'provider', name: 'apollo' }] };
    const res = await runDogi(config, { field: 'f', lead, waterfallFor: () => fakeWaterfall(null) });
    expect(res).toBeNull();
  });
});
