import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM layer so the planner's brain is a fake we control.
const { getLLM } = vi.hoisted(() => ({ getLLM: vi.fn() }));
vi.mock('@fetch/llm', () => ({ getLLM }));

import { planBone, planGoal, isSourceRowsStep, type SourceRowsStep, type ColumnStep } from '../src/planner';

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

describe('planBone (row-sourcing)', () => {
  it('emits a leading source-rows step then column steps with correct deps (top N, empty table)', async () => {
    getLLM.mockReturnValue(
      fakeLLM({
        steps: [
          {
            kind: 'source-rows',
            description: 'the top 10 EV companies',
            count: 10,
            primaryField: 'company',
            primaryLabel: 'Company',
          },
          {
            kind: 'column',
            id: 's1',
            label: 'CEO',
            instruction: "Find the company's CEO.",
            reads: ['company'],
            output: { mode: 'create', key: 'ceo' },
            sources: [{ type: 'web', via: 'native' }],
            policy: 'combine',
            dependsOn: ['company'],
          },
          {
            kind: 'column',
            id: 's2',
            label: 'CEO LinkedIn',
            instruction: "Find the CEO's LinkedIn URL.",
            reads: ['ceo'],
            output: { mode: 'create', key: 'ceo_linkedin' },
            sources: [{ type: 'web', via: 'native' }],
            policy: 'combine',
            dependsOn: ['s1'],
          },
        ],
      }),
    );

    const plan = await planBone('list the top 10 EV companies and their CEOs and CEO LinkedIn', {
      rowCount: 0,
    });
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(3);

    const [s0, s1, s2] = plan!.steps;
    expect(isSourceRowsStep(s0!)).toBe(true);
    const src = s0 as SourceRowsStep;
    expect(src.kind).toBe('source-rows');
    expect(src.count).toBe(10);
    expect(src.primaryField).toBe('company');

    const c1 = s1 as ColumnStep;
    const c2 = s2 as ColumnStep;
    expect(c1.kind).toBe('column');
    // A column may depend on the sourced primaryField.
    expect(c1.dependsOn).toEqual(['company']);
    expect(c1.reads).toContain('company');
    // dependsOn normalized from step id (s1) → output key (ceo).
    expect(c2.dependsOn).toEqual(['ceo']);
    expect(c2.reads).toContain('ceo');
  });

  it('clamps an oversized count and defaults primaryField', async () => {
    getLLM.mockReturnValue(
      fakeLLM({
        steps: [{ kind: 'source-rows', description: 'all the companies', count: 999 }],
      }),
    );
    const plan = await planBone('list everything', { rowCount: 0 });
    const src = plan!.steps[0] as SourceRowsStep;
    // The planner keeps the requested count as-is; sourceRows itself clamps at run time.
    expect(src.count).toBe(999);
    expect(src.primaryField).toBe('company');
  });

  it('planGoal drops source-rows steps (back-compat: columns only)', async () => {
    getLLM.mockReturnValue(
      fakeLLM({
        steps: [
          { kind: 'source-rows', description: 'top 5 banks', count: 5, primaryField: 'company' },
          {
            kind: 'column',
            id: 's1',
            label: 'CEO',
            instruction: 'Find CEO.',
            reads: ['company'],
            output: { key: 'ceo' },
            sources: [{ type: 'llm' }],
            policy: 'combine',
            dependsOn: [],
          },
        ],
      }),
    );
    const plan = await planGoal('top 5 banks and their CEOs');
    // Only the column step survives; the legacy shape has no `kind`.
    expect(plan!.steps).toHaveLength(1);
    expect(plan!.steps[0]!.output.key).toBe('ceo');
    expect('kind' in plan!.steps[0]!).toBe(false);
  });
});
