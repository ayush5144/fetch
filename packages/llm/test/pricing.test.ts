import { describe, expect, it } from 'vitest';
import { PRICING, TOKENS_PER_ROW, estimateCost } from '../src/pricing';
import type { LLMProvider } from '../src/index';

/**
 * Phase E §4 — cost estimation. The pricing table must cover all four providers
 * (each with input/output per-1M and a web-search per-1k add-on), and
 * `estimateCost` must turn rows → dollars with the documented token heuristic
 * and 400-on-unknown contract.
 */

const PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'gemini', 'grok'];

describe('PRICING table', () => {
  it('covers all four providers with web-search + at least one model each', () => {
    for (const p of PROVIDERS) {
      const entry = PRICING[p];
      expect(entry, `provider ${p}`).toBeDefined();
      expect(entry.webSearchPer1k).toBeGreaterThan(0);
      const models = Object.entries(entry.models);
      expect(models.length).toBeGreaterThan(0);
      for (const [model, price] of models) {
        expect(price.inputPerM, `${p}/${model} input`).toBeGreaterThan(0);
        expect(price.outputPerM, `${p}/${model} output`).toBeGreaterThan(0);
      }
    }
  });
});

describe('estimateCost', () => {
  it('computes cost from the token heuristic for each provider', () => {
    for (const provider of PROVIDERS) {
      const model = Object.keys(PRICING[provider].models)[0]!;
      const { inputPerM, outputPerM } = PRICING[provider].models[model]!;
      const rows = 100;

      const est = estimateCost({ provider, model, rows });

      const expectedInput = (rows * TOKENS_PER_ROW.input) / 1_000_000 * inputPerM;
      const expectedOutput = (rows * TOKENS_PER_ROW.output) / 1_000_000 * outputPerM;
      const expectedTotal = expectedInput + expectedOutput;

      expect(est.breakdown.inputTokens).toBe(rows * TOKENS_PER_ROW.input);
      expect(est.breakdown.outputTokens).toBe(rows * TOKENS_PER_ROW.output);
      expect(est.breakdown.inputCost).toBeCloseTo(expectedInput, 10);
      expect(est.breakdown.outputCost).toBeCloseTo(expectedOutput, 10);
      expect(est.breakdown.webSearchCost).toBe(0);
      expect(est.total).toBeCloseTo(expectedTotal, 10);
      expect(est.perRow).toBeCloseTo(expectedTotal / rows, 10);
    }
  });

  it('adds the per-1k web-search cost when webSearch is on', () => {
    const rows = 2000;
    const provider: LLMProvider = 'anthropic';
    const model = 'claude-opus-4-8';
    const without = estimateCost({ provider, model, rows });
    const withSearch = estimateCost({ provider, model, rows, webSearch: true });

    const expectedSearch = (rows / 1000) * PRICING[provider].webSearchPer1k;
    expect(withSearch.breakdown.webSearchCost).toBeCloseTo(expectedSearch, 10);
    expect(withSearch.total).toBeCloseTo(without.total + expectedSearch, 10);
  });

  it('returns zero for zero rows (no division blowup)', () => {
    const est = estimateCost({ provider: 'openai', model: 'gpt-4.1', rows: 0 });
    expect(est.total).toBe(0);
    expect(est.perRow).toBe(0);
  });

  it('throws on an unknown provider', () => {
    expect(() => estimateCost({ provider: 'mistral', model: 'x', rows: 10 })).toThrow();
  });

  it('throws on an unknown model for a known provider', () => {
    expect(() => estimateCost({ provider: 'anthropic', model: 'nope-9', rows: 10 })).toThrow();
  });
});
