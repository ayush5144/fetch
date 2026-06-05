import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, jobs, leads, tables } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';

/**
 * Phase I — Doggo (autonomous orchestrator + row-sourcing). We mock the planner
 * (`planDoggo`) and the row-sourcing primitive (`sourceRows`) so NO network is
 * touched. The endpoints' real work — inserting sourced rows as deduped leads,
 * creating columns (reusing apply-plan), and enqueuing the root columns — runs
 * against the test DB.
 */

const { planDoggo, sourceRows, getLLM } = vi.hoisted(() => ({
  planDoggo: vi.fn(),
  sourceRows: vi.fn(),
  getLLM: vi.fn(),
}));
vi.mock('@fetch/agent', async (orig) => ({ ...(await orig<any>()), planDoggo, sourceRows }));
vi.mock('@fetch/llm', async (orig) => ({ ...(await orig<any>()), getLLM }));

const { app } = await import('../src/app');

const T = DEFAULT_TABLE_ID;

// A plan: source 3 companies, then a CEO column depending on `company`.
const plan = {
  goal: 'top 3 EV companies and their CEOs',
  steps: [
    {
      kind: 'source-rows',
      description: 'the top 3 EV companies',
      count: 3,
      primaryField: 'company',
      primaryLabel: 'Company',
    },
    {
      kind: 'column',
      id: 's1',
      label: 'CEO',
      instruction: "Find the company's CEO.",
      reads: ['company'],
      output: { mode: 'create', key: 'ceo', label: 'CEO' },
      sources: [{ type: 'web', via: 'native' }],
      policy: 'combine',
      dependsOn: [],
    },
  ],
};

beforeAll(startQueues);
afterAll(stopQueues);
beforeEach(async () => {
  await truncateAll();
  planDoggo.mockReset();
  sourceRows.mockReset();
  getLLM.mockReset();
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /tables/:id/doggo/plan', () => {
  it('returns a plan without mutating', async () => {
    getLLM.mockReturnValue({ chat: vi.fn() });
    planDoggo.mockResolvedValue(plan);

    const res = await post(`/tables/${T}/doggo/plan`, { goal: plan.goal });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.steps).toHaveLength(2);
    expect(body.plan.steps[0].kind).toBe('source-rows');
    // No mutation: no columns created.
    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    expect(cols).toHaveLength(0);
  });

  it('404s for an unknown table', async () => {
    getLLM.mockReturnValue({ chat: vi.fn() });
    const res = await post(`/tables/nope/doggo/plan`, { goal: 'x' });
    expect(res.status).toBe(404);
  });

  it('400s on a missing goal', async () => {
    const res = await post(`/tables/${T}/doggo/plan`, {});
    expect(res.status).toBe(400);
  });
});

describe('POST /tables/:id/doggo/run', () => {
  it('creates the sourced rows, the columns, and enqueues the root column', async () => {
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }, { company: 'Rivian' }],
      provider: 'openai:test',
    });

    const res = await post(`/tables/${T}/doggo/run`, { plan });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowsCreated).toBe(3);
    expect(body.columnsCreated).toBe(1);

    // 3 leads, each carrying company in data.
    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows).toHaveLength(3);
    const companies = rows.map((r) => (r.data as any).company).sort();
    expect(companies).toEqual(['BYD', 'Rivian', 'Tesla']);

    // The CEO column was created as a dogi column.
    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    expect(ceo.type).toBe('dogi');

    // Root column enqueued once per sourced lead.
    expect(body.enqueued).toBe(3);
    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs).toHaveLength(3);
    expect((enrichJobs[0]!.payload as any).columnKey).toBe('ceo');
  });

  it('re-running with a `by columns` dedupe policy does NOT duplicate the rows', async () => {
    // Configure the table to dedupe by the `company` column.
    await db
      .update(tables)
      .set({ settings: { dedupe: { mode: 'columns', keys: ['company'] } } })
      .where(eq(tables.id, T));

    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }, { company: 'Rivian' }],
      provider: 'openai:test',
    });

    const first = await post(`/tables/${T}/doggo/run`, { plan });
    expect((await first.json()).rowsCreated).toBe(3);

    // Second run sources the same three — dedupe should merge, not duplicate.
    const second = await post(`/tables/${T}/doggo/run`, { plan });
    expect((await second.json()).rowsCreated).toBe(0);

    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows).toHaveLength(3);
  });

  it('honors table.settings.doggo.brain on the columns it builds', async () => {
    await db
      .update(tables)
      .set({ settings: { doggo: { brain: { provider: 'openai', model: 'gpt-4.1' } } } })
      .where(eq(tables.id, T));

    sourceRows.mockResolvedValue({ rows: [{ company: 'Tesla' }], provider: 'openai:test' });
    await post(`/tables/${T}/doggo/run`, { plan });

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    expect((ceo.config as any).brain).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('400s on an empty plan', async () => {
    const res = await post(`/tables/${T}/doggo/run`, { plan: { steps: [] } });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown table', async () => {
    const res = await post(`/tables/nope/doggo/run`, { plan });
    expect(res.status).toBe(404);
  });
});
