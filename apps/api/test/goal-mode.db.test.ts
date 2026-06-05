import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, jobs, leads } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';

/**
 * Phase D — goal mode (Ask Dogi → plan → apply). We mock the planner + LLM so no
 * network is touched: `ask-dogi` returns a structured plan (or a no-LLM reason),
 * and `apply-plan` creates one dogi column per step with `dependsOn`, then kicks
 * off the root steps across the table's leads.
 */

// A fake 2-step plan the planner returns, with a dependency.
const fakePlan = {
  goal: 'find CEO email then write a custom email',
  steps: [
    {
      id: 's1',
      label: 'CEO email',
      instruction: "Find the CEO's email.",
      reads: ['company', 'domain'],
      output: { mode: 'create', key: 'ceo_email', label: 'CEO email' },
      sources: [{ type: 'web', via: 'native' }],
      policy: 'combine',
      dependsOn: [],
    },
    {
      id: 's2',
      label: 'Custom email',
      instruction: 'Write a custom cold email.',
      reads: ['ceo_email', 'company'],
      output: { mode: 'create', key: 'custom_email', label: 'Custom email' },
      sources: [{ type: 'llm' }],
      policy: 'combine',
      dependsOn: ['ceo_email'],
    },
  ],
};

const { planGoal, getLLM } = vi.hoisted(() => ({ planGoal: vi.fn(), getLLM: vi.fn() }));
vi.mock('@fetch/agent', async (orig) => ({ ...(await orig<any>()), planGoal }));
vi.mock('@fetch/llm', async (orig) => ({ ...(await orig<any>()), getLLM }));

// Import the app AFTER mocks are registered.
const { app } = await import('../src/app');

const T = DEFAULT_TABLE_ID;

beforeAll(startQueues);
afterAll(stopQueues);
beforeEach(async () => {
  await truncateAll();
  planGoal.mockReset();
  getLLM.mockReset();
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /tables/:id/ask-dogi', () => {
  it('returns a structured plan, not prose', async () => {
    getLLM.mockReturnValue({ chat: vi.fn() });
    planGoal.mockResolvedValue(fakePlan);

    const res = await post(`/tables/${T}/ask-dogi`, { goal: fakePlan.goal });
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1].dependsOn).toEqual(['ceo_email']);
  });

  it('returns { plan: null, reason } when no LLM is configured', async () => {
    getLLM.mockReturnValue(null);
    const res = await post(`/tables/${T}/ask-dogi`, { goal: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null, reason: 'no LLM configured' });
    expect(planGoal).not.toHaveBeenCalled();
  });

  it('400s on a missing goal', async () => {
    const res = await post(`/tables/${T}/ask-dogi`, {});
    expect(res.status).toBe(400);
  });

  it('404s for an unknown table', async () => {
    getLLM.mockReturnValue({ chat: vi.fn() });
    const res = await post(`/tables/unknown-table/ask-dogi`, { goal: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /tables/:id/apply-plan', () => {
  it('creates one dogi column per step with dependsOn, and enqueues root steps', async () => {
    // A lead with an empty ceo_email cell → the root step enqueues for it.
    const [lead] = await db.insert(leads).values({ tableId: T, email: 'a@x.com' }).returning();

    const res = await post(`/tables/${T}/apply-plan`, { steps: fakePlan.steps });
    expect(res.status).toBe(201);
    const { columns: created, enqueued } = await res.json();
    expect(created).toHaveLength(2);

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const ceo = cols.find((cc) => cc.key === 'ceo_email')!;
    const custom = cols.find((cc) => cc.key === 'custom_email')!;
    expect(ceo.type).toBe('dogi');
    expect((ceo.config as any).dependsOn).toEqual([]);
    expect((custom.config as any).dependsOn).toEqual(['ceo_email']);
    expect((custom.config as any).instruction).toBe('Write a custom cold email.');

    // Only the ROOT step (ceo_email) is enqueued — custom_email waits on its dep.
    expect(enqueued).toBe(1);
    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs).toHaveLength(1);
    expect((enrichJobs[0]!.payload as any).columnKey).toBe('ceo_email');
    expect(enrichJobs[0]!.leadId).toBe(lead!.id);
  });

  it('is idempotent: re-applying reuses existing columns and does not duplicate', async () => {
    await post(`/tables/${T}/apply-plan`, { steps: fakePlan.steps });
    await post(`/tables/${T}/apply-plan`, { steps: fakePlan.steps });
    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    expect(cols.filter((cc) => cc.key === 'ceo_email')).toHaveLength(1);
    expect(cols.filter((cc) => cc.key === 'custom_email')).toHaveLength(1);
  });

  it('400s on empty steps', async () => {
    const res = await post(`/tables/${T}/apply-plan`, { steps: [] });
    expect(res.status).toBe(400);
  });
});
