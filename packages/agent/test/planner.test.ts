import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM layer so the planner's brain is a fake we control.
const { getLLM } = vi.hoisted(() => ({ getLLM: vi.fn() }));
vi.mock('@fetch/llm', () => ({ getLLM }));

import { planGoal } from '../src/planner';

/**
 * Phase D — the goal-mode planner. Pure unit tests with a mocked LLM: proves a
 * 2-step plan with a dependency for "find CEO email then write a custom email",
 * defensive parsing, and the no-LLM null path.
 */

/** An LLM client whose chat() returns a fixed JSON plan in its text. */
function fakeLLM(payload: unknown) {
  return {
    provider: 'anthropic',
    model: 'x',
    chat: vi.fn().mockResolvedValue({
      text: typeof payload === 'string' ? payload : JSON.stringify(payload),
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end',
    }),
  };
}

afterEach(() => getLLM.mockReset());

describe('planGoal', () => {
  it('returns a 2-step plan where step 2 depends on step 1 (CEO email → custom email)', async () => {
    getLLM.mockReturnValue(
      fakeLLM({
        steps: [
          {
            id: 's1',
            label: 'CEO email',
            instruction: "Find the company's CEO's email.",
            reads: ['company', 'domain'],
            output: { mode: 'create', key: 'ceo_email', label: 'CEO email' },
            sources: [{ type: 'web', via: 'native' }, { type: 'llm' }],
            policy: 'combine',
            dependsOn: [],
          },
          {
            id: 's2',
            label: 'Custom email',
            instruction: 'Write a short custom cold email to the CEO.',
            reads: ['company', 'first_name'],
            output: { mode: 'create', key: 'custom_email' },
            sources: [{ type: 'llm' }],
            policy: 'combine',
            dependsOn: ['s1'],
          },
        ],
      }),
    );

    const plan = await planGoal('find CEO email then write a custom email');
    expect(plan).not.toBeNull();
    expect(plan!.goal).toBe('find CEO email then write a custom email');
    expect(plan!.steps).toHaveLength(2);

    const [s1, s2] = plan!.steps;
    expect(s1!.output.key).toBe('ceo_email');
    expect(s1!.dependsOn).toEqual([]);

    expect(s2!.output.key).toBe('custom_email');
    // dependsOn is normalized from the step id (s1) to the output key (ceo_email).
    expect(s2!.dependsOn).toEqual(['ceo_email']);
    // a dependency you depend on must also be readable.
    expect(s2!.reads).toContain('ceo_email');
  });

  it('returns null when no LLM is configured', async () => {
    getLLM.mockReturnValue(null);
    expect(await planGoal('do something')).toBeNull();
  });

  it('parses defensively: bad JSON yields an empty-step plan, not a throw', async () => {
    getLLM.mockReturnValue(fakeLLM('sorry, I cannot do that'));
    const plan = await planGoal('whatever');
    expect(plan).toEqual({ goal: 'whatever', steps: [] });
  });

  it('snake_cases and de-duplicates output keys', async () => {
    getLLM.mockReturnValue(
      fakeLLM({
        steps: [
          { instruction: 'a', output: { key: 'CEO Email' }, label: 'A' },
          { instruction: 'b', output: { key: 'CEO Email' }, label: 'B' },
        ],
      }),
    );
    const plan = await planGoal('g');
    expect(plan!.steps.map((s) => s.output.key)).toEqual(['ceo_email', 'ceo_email_2']);
  });
});
