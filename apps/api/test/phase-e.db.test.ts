import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, agents, columns, db, jobs, leads } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';
import { app } from '../src/app';

/**
 * Phase E (saved agents · cost estimate · test-5) — backend slice, through the
 * real Hono app against the disposable test DB:
 *  - agents CRUD: save → list → delete.
 *  - /estimate-cost shape + 400 on an unknown provider/model.
 *  - run with `limit: 5` enqueues exactly 5 when more cells are empty.
 */

const T = DEFAULT_TABLE_ID;

beforeAll(startQueues);
afterAll(stopQueues);
beforeEach(truncateAll);

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agents CRUD', () => {
  it('save → list → delete', async () => {
    const config = { kind: 'dogi', instruction: 'find the CEO email', reads: ['company'] };
    const created = await post('/agents', { name: 'CEO finder', kind: 'dogi', config });
    expect(created.status).toBe(201);
    const { agent } = await created.json();
    expect(agent.name).toBe('CEO finder');
    expect(agent.kind).toBe('dogi');
    expect(agent.config).toMatchObject(config);

    const list = await (await app.request('/agents')).json();
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0].id).toBe(agent.id);

    const del = await app.request(`/agents/${agent.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const after = await (await app.request('/agents')).json();
    expect(after.agents).toHaveLength(0);

    const rows = await db.query.agents.findMany({ where: eq(agents.id, agent.id) });
    expect(rows).toHaveLength(0);
  });

  it('saves a goal-plan (kind: plan)', async () => {
    const res = await post('/agents', {
      name: 'CEO outreach',
      kind: 'plan',
      config: { kind: 'dogi-plan', steps: [{ id: 's1' }] },
    });
    expect(res.status).toBe(201);
    const { agent } = await res.json();
    expect(agent.kind).toBe('plan');
  });

  it('400s on a bad kind, 404s deleting an unknown id', async () => {
    expect((await post('/agents', { name: 'x', kind: 'nope', config: {} })).status).toBe(400);
    expect((await app.request('/agents/missing', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /estimate-cost', () => {
  it('returns { perRow, total, breakdown } for a known provider/model', async () => {
    const res = await post('/estimate-cost', {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      rows: 100,
      webSearch: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.perRow).toBeGreaterThan(0);
    expect(body.breakdown.webSearchCost).toBeGreaterThan(0);
    expect(body.breakdown).toHaveProperty('inputTokens');
    expect(body.breakdown).toHaveProperty('outputTokens');
  });

  it('400s on an unknown provider/model', async () => {
    expect((await post('/estimate-cost', { provider: 'mistral', model: 'x', rows: 10 })).status).toBe(400);
    expect(
      (await post('/estimate-cost', { provider: 'anthropic', model: 'nope-9', rows: 10 })).status,
    ).toBe(400);
  });
});

describe('run with limit (Test N rows)', () => {
  async function seed(n: number) {
    await db
      .insert(columns)
      .values({ tableId: T, key: 'ceo_email', label: 'CEO email', type: 'dogi', config: {} });
    for (let i = 0; i < n; i++) {
      await db.insert(leads).values({ tableId: T, email: `lead${i}@x.com`, position: i });
    }
  }

  it('column run with limit:5 enqueues exactly 5 when more are empty', async () => {
    await seed(8);
    const all = await db.query.leads.findMany({ where: eq(leads.tableId, T) });

    const res = await post(`/tables/${T}/columns/ceo_email/run`, {
      leadIds: all.map((l) => l.id),
      limit: 5,
    });
    expect(res.status).toBe(202);
    expect((await res.json()).enqueued).toBe(5);

    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs).toHaveLength(5);
  });

  it('column run without limit enqueues all empty cells', async () => {
    await seed(8);
    const all = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    const res = await post(`/tables/${T}/columns/ceo_email/run`, { leadIds: all.map((l) => l.id) });
    expect((await res.json()).enqueued).toBe(8);
  });

  it('table run with limit:5 enqueues exactly 5 per dogi column', async () => {
    await seed(8);
    const all = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    const res = await post(`/tables/${T}/run`, { leadIds: all.map((l) => l.id), limit: 5 });
    expect(res.status).toBe(202);
    expect((await res.json()).enqueued).toBe(5);
    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs).toHaveLength(5);
  });
});
