import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, jobs, leads, tables } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { seedBlankLead, startQueues, stopQueues } from '@fetch/core';

/**
 * Phase I — Bone (autonomous orchestrator + row-sourcing). We mock the planner
 * (`planBone`) and the row-sourcing primitive (`sourceRows`) so NO network is
 * touched. The endpoints' real work — inserting sourced rows as deduped leads,
 * creating columns (reusing apply-plan), and enqueuing the root columns — runs
 * against the test DB.
 */

const { planBone, sourceRows, getLLM } = vi.hoisted(() => ({
  planBone: vi.fn(),
  sourceRows: vi.fn(),
  getLLM: vi.fn(),
}));
vi.mock('@fetch/agent', async (orig) => ({ ...(await orig<any>()), planBone, sourceRows }));
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
  planBone.mockReset();
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

describe('POST /tables/:id/bone/plan', () => {
  it('returns a plan without mutating', async () => {
    getLLM.mockReturnValue({ chat: vi.fn() });
    planBone.mockResolvedValue(plan);

    const res = await post(`/tables/${T}/bone/plan`, { goal: plan.goal });
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
    const res = await post(`/tables/nope/bone/plan`, { goal: 'x' });
    expect(res.status).toBe(404);
  });

  it('400s on a missing goal', async () => {
    const res = await post(`/tables/${T}/bone/plan`, {});
    expect(res.status).toBe(400);
  });
});

describe('POST /tables/:id/bone/run', () => {
  it('creates the sourced rows, the columns, and enqueues the root column', async () => {
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }, { company: 'Rivian' }],
      provider: 'openai:test',
    });

    const res = await post(`/tables/${T}/bone/run`, { plan });
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

  it('materializes a manual column for the sourced primaryField, left of enrichment (R1.1)', async () => {
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }],
      provider: 'openai:test',
    });

    await post(`/tables/${T}/bone/run`, { plan });

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const company = cols.find((cc) => cc.key === 'company');
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    // A manual `company` column now exists with the planned label...
    expect(company).toBeTruthy();
    expect(company!.type).toBe('manual');
    expect(company!.label).toBe('Company');
    // ...and it sorts LEFT of the ceo enrichment column.
    expect(company!.position).toBeLessThan(ceo.position);

    // The sourced values are addressable under that column's key.
    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows.map((r) => (r.data as any).company).sort()).toEqual(['BYD', 'Tesla']);
  });

  it('reuses the seeded blank row → exactly N rows, none blank (R1.2)', async () => {
    // A fresh table has ONE blank seed row.
    await seedBlankLead(T);
    const seeded = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(seeded).toHaveLength(1);

    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }, { company: 'Rivian' }],
      provider: 'openai:test',
    });

    const res = await post(`/tables/${T}/bone/run`, { plan });
    expect((await res.json()).rowsCreated).toBe(3);

    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    // Exactly 3 (the blank was filled, not appended-to) and none is blank.
    expect(rows).toHaveLength(3);
    const companies = rows.map((r) => (r.data as any).company).sort();
    expect(companies).toEqual(['BYD', 'Rivian', 'Tesla']);
    for (const r of rows) expect((r.data as any).company).toBeTruthy();
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

    const first = await post(`/tables/${T}/bone/run`, { plan });
    expect((await first.json()).rowsCreated).toBe(3);

    // Second run sources the same three — dedupe should merge, not duplicate.
    const second = await post(`/tables/${T}/bone/run`, { plan });
    expect((await second.json()).rowsCreated).toBe(0);

    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows).toHaveLength(3);
  });

  it('honors table.settings.bone.brain on the columns it builds', async () => {
    await db
      .update(tables)
      .set({ settings: { bone: { brain: { provider: 'openai', model: 'gpt-4.1' } } } })
      .where(eq(tables.id, T));

    sourceRows.mockResolvedValue({ rows: [{ company: 'Tesla' }], provider: 'openai:test' });
    await post(`/tables/${T}/bone/run`, { plan });

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    expect((ceo.config as any).brain).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('400s on an empty plan', async () => {
    const res = await post(`/tables/${T}/bone/run`, { plan: { steps: [] } });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown table', async () => {
    const res = await post(`/tables/nope/bone/run`, { plan });
    expect(res.status).toBe(404);
  });

  it('persists a settings.flows entry and tags created columns with flowId (Round 9)', async () => {
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }],
      provider: 'openai:test',
    });

    const res = await post(`/tables/${T}/bone/run`, { plan });
    const body = await res.json();
    expect(body.flowId).toMatch(/^flow_/);

    // A flow entry is persisted on the table's settings.
    const tbl = await db.query.tables.findFirst({ where: eq(tables.id, T) });
    const flows = (tbl!.settings as any).flows;
    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.id).toBe(body.flowId);
    expect(flow.name).toBe('top 3 EV companies and their CEOs');
    expect(flow.goal).toBe('top 3 EV companies and their CEOs');
    // columnKeys covers the sourced primary + the dogi output.
    expect(flow.columnKeys.sort()).toEqual(['ceo', 'company']);
    // sourceSteps carries the source-rows step.
    expect(flow.sourceSteps).toHaveLength(1);
    expect(flow.sourceSteps[0].primaryField).toBe('company');
    expect(typeof flow.createdAt).toBe('string');

    // Both the sourced primary column AND the dogi column carry config.flowId.
    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const company = cols.find((cc) => cc.key === 'company')!;
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    expect((company.config as any).flowId).toBe(body.flowId);
    expect((ceo.config as any).flowId).toBe(body.flowId);
  });
});

describe('POST /tables/:id/flow/:flowId/run', () => {
  async function runBone() {
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Tesla' }, { company: 'BYD' }],
      provider: 'openai:test',
    });
    const res = await post(`/tables/${T}/bone/run`, { plan });
    return (await res.json()).flowId as string;
  }

  it('appends ~sourceMore rows and enqueues the flow columns', async () => {
    const flowId = await runBone();
    // Clear the enrich jobs from the initial bone/run so we count only the re-run.
    await db.delete(jobs).where(eq(jobs.type, 'enrich'));

    // The flow re-run sources 2 MORE companies and re-fills the ceo column.
    sourceRows.mockResolvedValue({
      rows: [{ company: 'Rivian' }, { company: 'Lucid' }],
      provider: 'openai:test',
    });
    const res = await post(`/tables/${T}/flow/${flowId}/run`, { sourceMore: 2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowsCreated).toBe(2); // 2 sourced rows appended
    expect(body.columnsRun).toBe(1); // the ceo column

    // 4 leads now (2 from bone/run + 2 appended), none blank.
    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows).toHaveLength(4);

    // The ceo column was enqueued across the empty cells.
    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs.length).toBe(body.enqueued);
    expect(enrichJobs.every((j) => (j.payload as any).columnKey === 'ceo')).toBe(true);
  });

  it('404s for an unknown flow', async () => {
    const res = await post(`/tables/${T}/flow/flow_nope/run`, { sourceMore: 1 });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown table', async () => {
    const res = await post(`/tables/nope/flow/flow_x/run`, {});
    expect(res.status).toBe(404);
  });

  it('force clears filled cells so they re-run', async () => {
    const flowId = await runBone();
    await db.delete(jobs).where(eq(jobs.type, 'enrich'));

    // Simulate the ceo cells being filled.
    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    for (const r of rows) {
      await db
        .update(leads)
        .set({ data: { ...(r.data as any), ceo: 'Someone' } })
        .where(eq(leads.id, r.id));
    }

    // Without force: filled cells are skipped → nothing enqueued.
    const noForce = await post(`/tables/${T}/flow/${flowId}/run`, {});
    expect((await noForce.json()).enqueued).toBe(0);

    // With force: cells are cleared first → all re-enqueue.
    const forced = await post(`/tables/${T}/flow/${flowId}/run`, { force: true });
    const fbody = await forced.json();
    expect(fbody.enqueued).toBe(rows.length);

    // The values were cleared from data.
    const after = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    for (const r of after) expect((r.data as any).ceo).toBeUndefined();
  });
});

describe('apply-plan flowId isolation (Round 9)', () => {
  it('does NOT tag apply-plan columns with a flowId', async () => {
    const res = await post(`/tables/${T}/apply-plan`, {
      steps: [
        {
          label: 'CEO',
          instruction: "Find the company's CEO.",
          reads: ['company'],
          output: { mode: 'create', key: 'ceo', label: 'CEO' },
          sources: [{ type: 'llm' }],
          policy: 'combine',
          dependsOn: [],
        },
      ],
    });
    expect(res.status).toBe(201);

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const ceo = cols.find((cc) => cc.key === 'ceo')!;
    expect((ceo.config as any).flowId).toBeUndefined();

    // No flow persisted either.
    const tbl = await db.query.tables.findFirst({ where: eq(tables.id, T) });
    expect((tbl!.settings as any)?.flows).toBeUndefined();
  });
});
