import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM layer so the row-sourcing brain is a fake we control (no network).
const { getLLM } = vi.hoisted(() => ({ getLLM: vi.fn() }));
vi.mock('@fetch/llm', () => ({ getLLM }));

import { sourceRows, MAX_SOURCE_ROWS } from '../src/sourceRows';

/**
 * Phase I — the row-sourcing primitive. Pure unit tests with a mocked LLM:
 * proves it parses a JSON array, clamps the count, keeps only requested fields,
 * and never throws (returns rows: [] on parse failure / no LLM).
 */

/** An LLM whose chat() returns fixed text (the array, or prose). */
function fakeLLM(text: string) {
  return {
    provider: 'openai',
    model: 'gpt-test',
    chat: vi.fn().mockResolvedValue({
      text,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end',
    }),
  };
}

afterEach(() => getLLM.mockReset());

describe('sourceRows', () => {
  it('parses a JSON array of entities into rows', async () => {
    getLLM.mockReturnValue(
      fakeLLM('[{"company":"Apple"},{"company":"Microsoft"},{"company":"Nvidia"}]'),
    );
    const { rows, provider } = await sourceRows({
      description: 'top 3 tech companies',
      count: 3,
      fields: ['company'],
    });
    expect(rows).toEqual([{ company: 'Apple' }, { company: 'Microsoft' }, { company: 'Nvidia' }]);
    expect(provider).toBe('openai:gpt-test');
  });

  it('strips prose around the array and ignores non-object / empty elements', async () => {
    getLLM.mockReturnValue(
      fakeLLM('Sure! Here you go:\n[{"company":"Apple"}, 42, {"company":""}, {"x":"y"}]\nDone.'),
    );
    const { rows } = await sourceRows({ description: 'x', count: 5, fields: ['company'] });
    // Only the one element with a non-empty `company` survives.
    expect(rows).toEqual([{ company: 'Apple' }]);
  });

  it('clamps the count to MAX_SOURCE_ROWS', async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ company: `c${i}` }));
    getLLM.mockReturnValue(fakeLLM(JSON.stringify(big)));
    const { rows } = await sourceRows({ description: 'all companies', count: 999 });
    expect(rows.length).toBe(MAX_SOURCE_ROWS);
  });

  it('defaults fields to ["company"]', async () => {
    getLLM.mockReturnValue(fakeLLM('[{"company":"Tesla"}]'));
    const { rows } = await sourceRows({ description: 'top EV maker', count: 1 });
    expect(rows).toEqual([{ company: 'Tesla' }]);
  });

  it('returns rows: [] on unparseable output, never throws', async () => {
    getLLM.mockReturnValue(fakeLLM('sorry, I cannot help with that'));
    const { rows } = await sourceRows({ description: 'x', count: 3 });
    expect(rows).toEqual([]);
  });

  it('returns rows: [] when no LLM is configured', async () => {
    getLLM.mockReturnValue(null);
    const { rows, provider } = await sourceRows({ description: 'x', count: 3 });
    expect(rows).toEqual([]);
    expect(provider).toBe('none');
  });

  it('returns rows: [] when the LLM call throws (never fatal)', async () => {
    getLLM.mockReturnValue({
      provider: 'openai',
      model: 'm',
      chat: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { rows } = await sourceRows({ description: 'x', count: 3 });
    expect(rows).toEqual([]);
  });
});
