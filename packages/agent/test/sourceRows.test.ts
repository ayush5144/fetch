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

/** An LLM whose chat() returns each `texts` entry on successive calls. */
function sequencedLLM(...texts: string[]) {
  const chat = vi.fn();
  for (const t of texts) {
    chat.mockResolvedValueOnce({
      text: t,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end',
    });
  }
  return { provider: 'openai', model: 'gpt-test', chat };
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

  // ── Exact-count contract (R1.3) ────────────────────────────────────────────
  it('TRIMS to exactly count when the model returns MORE', async () => {
    const llm = sequencedLLM(
      '[{"company":"A"},{"company":"B"},{"company":"C"},{"company":"D"},' +
        '{"company":"E"},{"company":"F"},{"company":"G"},{"company":"H"},' +
        '{"company":"I"},{"company":"J"},{"company":"K"},{"company":"L"}]',
    );
    getLLM.mockReturnValue(llm);
    const { rows } = await sourceRows({ description: 'companies', count: 10 });
    expect(rows.length).toBe(10);
    // Exactly one call — no re-prompt needed when we already have enough.
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('RE-PROMPTS ONCE for the remainder when the first reply is short', async () => {
    const llm = sequencedLLM(
      '[{"company":"A"},{"company":"B"},{"company":"C"}]',
      '[{"company":"D"},{"company":"E"}]',
    );
    getLLM.mockReturnValue(llm);
    const { rows } = await sourceRows({ description: 'companies', count: 5 });
    expect(rows.map((r) => r.company)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('does NOT loop forever — returns what it has after one re-prompt (2 then 2 → 2)', async () => {
    // Both calls return the SAME two; after dedupe + one re-prompt we keep 2.
    const llm = sequencedLLM(
      '[{"company":"A"},{"company":"B"}]',
      '[{"company":"A"},{"company":"B"}]',
    );
    getLLM.mockReturnValue(llm);
    const { rows } = await sourceRows({ description: 'companies', count: 5 });
    expect(rows.map((r) => r.company)).toEqual(['A', 'B']);
    expect(llm.chat).toHaveBeenCalledTimes(2); // one re-prompt, then stop
  });

  it('de-duplicates across the first call and the re-prompt', async () => {
    const llm = sequencedLLM(
      '[{"company":"A"},{"company":"B"}]',
      '[{"company":"B"},{"company":"C"},{"company":"D"}]',
    );
    getLLM.mockReturnValue(llm);
    const { rows } = await sourceRows({ description: 'companies', count: 4 });
    // B from the second call is dropped as a dup; C and D fill to 4.
    expect(rows.map((r) => r.company)).toEqual(['A', 'B', 'C', 'D']);
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

  it('wires a quality system prompt that forbids sub-brands / divisions (R1.4)', async () => {
    const llm = fakeLLM('[{"company":"OpenAI"}]');
    getLLM.mockReturnValue(llm);
    await sourceRows({ description: 'AI companies', count: 1 });
    const system = (llm.chat.mock.calls[0]![0] as { messages: { role: string; content: string }[] })
      .messages.find((m) => m.role === 'system')!.content;
    // It must steer toward real parent companies and away from product lines.
    expect(system).toMatch(/division|sub-brand|product line/i);
    expect(system).toMatch(/parent/i);
    expect(system).toMatch(/distinct/i);
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
