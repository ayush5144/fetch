import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, jobs, leads } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { startQueues, stopQueues } from '@fetch/core';
import { app } from '../src/app';

/**
 * Phase B (Clay grid) — backend slice. Exercises the table-scoped grid surface
 * through the real Hono app: column/row reorder, column duplicate, typed-cell
 * validation, and the cell-jobs projection. Talks to the disposable test DB.
 */

const T = DEFAULT_TABLE_ID;

async function makeColumn(key: string, label: string, extra: Record<string, unknown> = {}) {
  const [col] = await db
    .insert(columns)
    .values({ tableId: T, key, label, type: 'manual', config: {}, ...extra })
    .returning();
  return col!;
}

async function makeLead(email: string, position = 0) {
  const [lead] = await db.insert(leads).values({ tableId: T, email, position }).returning();
  return lead!;
}

describe('column & lead ordering', () => {
  beforeEach(truncateAll);

  it('GET columns/leads order by position then created_at', async () => {
    await makeColumn('b', 'B', { position: 1 });
    await makeColumn('a', 'A', { position: 0 });
    const l1 = await makeLead('one@x.com', 5);
    const l2 = await makeLead('two@x.com', 1);

    const cols = await (await app.request(`/tables/${T}/columns`)).json();
    expect(cols.columns.map((c: any) => c.key)).toEqual(['a', 'b']);

    const rows = await (await app.request(`/tables/${T}/leads`)).json();
    expect(rows.leads.map((l: any) => l.id)).toEqual([l2.id, l1.id]);
  });
});

describe('reorder', () => {
  beforeEach(truncateAll);

  it('columns/reorder sets position to the index of each id', async () => {
    const a = await makeColumn('a', 'A', { position: 0 });
    const b = await makeColumn('b', 'B', { position: 1 });
    const cc = await makeColumn('c', 'C', { position: 2 });

    const res = await app.request(`/tables/${T}/columns/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: [cc.id, a.id, b.id] }),
    });
    expect(res.status).toBe(200);

    const fresh = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    const pos = Object.fromEntries(fresh.map((c) => [c.key, c.position]));
    expect(pos).toEqual({ c: 0, a: 1, b: 2 });
  });

  it('leads/reorder sets position to the index of each id', async () => {
    const a = await makeLead('a@x.com', 0);
    const b = await makeLead('b@x.com', 1);

    await app.request(`/tables/${T}/leads/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: [b.id, a.id] }),
    });

    const fresh = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    const pos = Object.fromEntries(fresh.map((l) => [l.email, l.position]));
    expect(pos).toEqual({ 'b@x.com': 0, 'a@x.com': 1 });
  });

  it('reorder never writes across tables (ids from another table are ignored)', async () => {
    const [other] = await db.insert((await import('@fetch/db')).tables).values({ name: 'Other' }).returning();
    const mine = await makeColumn('mine', 'Mine', { position: 0 });
    const [theirs] = await db
      .insert(columns)
      .values({ tableId: other!.id, key: 'theirs', label: 'Theirs', type: 'manual', position: 9 })
      .returning();

    await app.request(`/tables/${T}/columns/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: [theirs!.id, mine.id] }),
    });

    // `theirs` is at index 0 in the payload but belongs to another table → untouched.
    const t = await db.query.columns.findFirst({ where: eq(columns.id, theirs!.id) });
    expect(t!.position).toBe(9);
    const m = await db.query.columns.findFirst({ where: eq(columns.id, mine.id) });
    expect(m!.position).toBe(1);
  });
});

describe('column duplicate', () => {
  beforeEach(truncateAll);

  it('copies type/config/width with a unique _copy key+label at the end', async () => {
    await makeColumn('ceo_email', 'CEO email', {
      type: 'dogi',
      config: { valueType: 'email', instruction: 'find it' },
      width: 220,
      position: 0,
    });

    const res = await app.request(`/tables/${T}/columns/ceo_email/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const { column } = await res.json();
    expect(column.key).toBe('ceo_email_copy');
    expect(column.label).toBe('CEO email_copy');
    expect(column.type).toBe('dogi');
    expect(column.config).toMatchObject({ valueType: 'email', instruction: 'find it' });
    expect(column.width).toBe(220);
    expect(column.position).toBe(1); // appended after the source (max pos + 1)
  });

  it('bumps the suffix when _copy already exists', async () => {
    await makeColumn('note', 'Note', { position: 0 });
    await makeColumn('note_copy', 'Note_copy', { position: 1 });

    const { column } = await (
      await app.request(`/tables/${T}/columns/note/duplicate`, { method: 'POST' })
    ).json();
    expect(column.key).toBe('note_copy1');
    expect(column.label).toBe('Note_copy1');
  });

  it('404s for an unknown column', async () => {
    const res = await app.request(`/tables/${T}/columns/nope/duplicate`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /columns/:id — position/width/label + 409 on dup name', () => {
  beforeEach(truncateAll);

  it('persists position and width', async () => {
    const col = await makeColumn('a', 'A');
    const res = await app.request(`/columns/${col.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: 4, width: 300 }),
    });
    expect(res.status).toBe(200);
    const fresh = await db.query.columns.findFirst({ where: eq(columns.id, col.id) });
    expect(fresh!.position).toBe(4);
    expect(fresh!.width).toBe(300);
  });

  it('returns 409 when renaming to an existing label', async () => {
    await makeColumn('a', 'Alpha');
    const b = await makeColumn('b', 'Beta');
    const res = await app.request(`/columns/${b.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Alpha' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('typed-cell validation (PATCH /leads/:id/cell)', () => {
  beforeEach(truncateAll);

  async function patchCell(leadId: string, key: string, value: unknown) {
    return app.request(`/leads/${leadId}/cell`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
  }

  it('rejects an invalid email with 400 and a clear message', async () => {
    await makeColumn('ceo_email', 'CEO email', { config: { valueType: 'email' } });
    const lead = await makeLead('row@x.com');
    const res = await patchCell(lead.id, 'ceo_email', 'not-an-email');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);

    const unchanged = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect((unchanged!.data as any).ceo_email).toBeUndefined();
  });

  it('persists a valid email', async () => {
    await makeColumn('ceo_email', 'CEO email', { config: { valueType: 'email' } });
    const lead = await makeLead('row@x.com');
    const res = await patchCell(lead.id, 'ceo_email', 'ava@acme.com');
    expect(res.status).toBe(200);
    const fresh = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect((fresh!.data as any).ceo_email).toBe('ava@acme.com');
  });

  it('coerces a numeric string for a number column', async () => {
    await makeColumn('size', 'Size', { config: { valueType: 'number' } });
    const lead = await makeLead('row@x.com');
    await patchCell(lead.id, 'size', '240');
    const fresh = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect((fresh!.data as any).size).toBe(240);
  });

  it('allows any value when the column has no value type (text)', async () => {
    await makeColumn('note', 'Note');
    const lead = await makeLead('row@x.com');
    const res = await patchCell(lead.id, 'note', 'free text 123');
    expect(res.status).toBe(200);
  });

  it('allows a value with no matching column (unknown key passes through)', async () => {
    const lead = await makeLead('row@x.com');
    const res = await patchCell(lead.id, 'adhoc', 'whatever');
    expect(res.status).toBe(200);
  });
});

describe('GET /tables/:id/cell-jobs', () => {
  beforeEach(truncateAll);

  it('returns non-terminal enrich jobs with leadId + columnKey + status', async () => {
    const lead = await makeLead('row@x.com');
    // Two non-terminal enrich jobs and noise that must be excluded.
    await db.insert(jobs).values([
      { type: 'enrich', leadId: lead.id, status: 'queued', payload: { columnKey: 'ceo_email' } },
      { type: 'enrich', leadId: lead.id, status: 'active', payload: { columnKey: 'signal' } },
      { type: 'enrich', leadId: lead.id, status: 'completed', payload: { columnKey: 'done' } },
      { type: 'validate', leadId: lead.id, status: 'queued', payload: { columnKey: 'nope' } },
    ]);

    const { jobs: out } = await (await app.request(`/tables/${T}/cell-jobs`)).json();
    expect(out).toHaveLength(2);
    const byKey = Object.fromEntries(out.map((j: any) => [j.columnKey, j.status]));
    expect(byKey).toEqual({ ceo_email: 'queued', signal: 'active' });
    expect(out.every((j: any) => j.leadId === lead.id)).toBe(true);
  });

  it('scopes to the table — jobs in another table are excluded', async () => {
    const [other] = await db.insert((await import('@fetch/db')).tables).values({ name: 'Other' }).returning();
    const [otherLead] = await db.insert(leads).values({ tableId: other!.id, email: 'o@x.com' }).returning();
    await db
      .insert(jobs)
      .values({ type: 'enrich', leadId: otherLead!.id, status: 'queued', payload: { columnKey: 'x' } });

    const { jobs: out } = await (await app.request(`/tables/${T}/cell-jobs`)).json();
    expect(out).toHaveLength(0);
  });
});

describe('DELETE /leads/:id — single delete', () => {
  beforeEach(truncateAll);

  it('deletes a lead and returns { ok: true }', async () => {
    const lead = await makeLead('gone@x.com');
    const res = await app.request(`/leads/${lead.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const fresh = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(fresh).toBeUndefined();
  });

  it('404s for an unknown lead', async () => {
    const res = await app.request(`/leads/00000000-0000-0000-0000-000000000000`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('POST /tables/:id/leads/delete — bulk delete', () => {
  beforeEach(truncateAll);

  it('deletes only the given leads and returns the count', async () => {
    const a = await makeLead('a@x.com');
    const b = await makeLead('b@x.com');
    const c = await makeLead('c@x.com');

    const res = await app.request(`/tables/${T}/leads/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadIds: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    const remaining = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(remaining.map((l) => l.id)).toEqual([c.id]);
  });

  it('does not delete a lead that lives in another table', async () => {
    const [other] = await db.insert((await import('@fetch/db')).tables).values({ name: 'Other' }).returning();
    const mine = await makeLead('mine@x.com');
    const [theirs] = await db.insert(leads).values({ tableId: other!.id, email: 'theirs@x.com' }).returning();

    const res = await app.request(`/tables/${T}/leads/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // both ids passed, but theirs belongs to another table → must survive
      body: JSON.stringify({ leadIds: [mine.id, theirs!.id] }),
    });
    expect(await res.json()).toEqual({ deleted: 1 });

    const survived = await db.query.leads.findFirst({ where: eq(leads.id, theirs!.id) });
    expect(survived).toBeTruthy();
    const gone = await db.query.leads.findFirst({ where: eq(leads.id, mine.id) });
    expect(gone).toBeUndefined();
  });
});

describe('POST /tables/:id/run — run runnable columns over rows', () => {
  beforeAll(startQueues);
  afterAll(stopQueues);
  beforeEach(truncateAll);

  it('enqueues enrich jobs only for selected leads × dogi columns with an empty cell', async () => {
    await makeColumn('ceo_email', 'CEO email', { type: 'dogi', config: { valueType: 'email' } });
    await makeColumn('note', 'Note', { type: 'manual' }); // skipped

    const selected = await makeLead('sel@x.com');
    // a second lead that is NOT selected → no job for it
    await makeLead('other@x.com');
    // a lead whose dogi cell is already filled → run-only-if-empty skips it
    const [filled] = await db
      .insert(leads)
      .values({ tableId: T, email: 'filled@x.com', data: { ceo_email: 'set@x.com' } })
      .returning();

    const res = await app.request(`/tables/${T}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leadIds: [selected.id, filled!.id] }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: 1, formula: 0 });

    const enrichJobs = await db.query.jobs.findMany({ where: eq(jobs.type, 'enrich') });
    expect(enrichJobs).toHaveLength(1);
    expect(enrichJobs[0]!.leadId).toBe(selected.id);
    expect((enrichJobs[0]!.payload as any).columnKey).toBe('ceo_email');
  });
});

describe('POST /tables/:id/leads — quick-add stores arbitrary keys in data', () => {
  // Quick-add can enqueue a `validate` job for a lead with an email, so the queue
  // must be running for the handler not to throw.
  beforeAll(startQueues);
  afterAll(stopQueues);
  beforeEach(truncateAll);

  async function quickAdd(body: unknown) {
    const res = await app.request(`/tables/${T}/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  it('writes EVERY provided key into leads.data (the company/note anchor fix)', async () => {
    const { res, json } = await quickAdd({ company: 'Tata', note: 'x' });
    expect(res.status).toBe(201);
    const data = json.lead.data as Record<string, unknown>;
    expect(data.company).toBe('Tata');
    expect(data.note).toBe('x');
  });

  it('mirrors recognized identity to canonical AND keeps it in data', async () => {
    const { json } = await quickAdd({ email: 'a@b.com', company: 'X' });
    // arbitrary key landed in data
    expect((json.lead.data as any).company).toBe('X');
    // recognized identity mirrored to the canonical column for send/dedupe
    expect(json.lead.email).toBe('a@b.com');
    // and the email is also visible as a data cell
    expect((json.lead.data as any).email).toBe('a@b.com');
  });

  it('splits a full name into first/last and mirrors title/linkedin', async () => {
    const { json } = await quickAdd({
      name: 'Wes Schroll',
      title: 'CEO',
      linkedin_url: 'https://linkedin.com/in/wes',
      company: 'Fetch',
    });
    expect(json.lead.firstName).toBe('Wes');
    expect(json.lead.lastName).toBe('Schroll');
    expect(json.lead.title).toBe('CEO');
    expect(json.lead.linkedinUrl).toBe('https://linkedin.com/in/wes');
    expect((json.lead.data as any).company).toBe('Fetch');
  });

  it('an empty body still creates a blank "+ new lead" row', async () => {
    const { res, json } = await quickAdd({});
    expect(res.status).toBe(201);
    expect(json.created).toBe(true);
    expect(json.lead.email).toBeNull();
    expect(json.lead.data).toEqual({});
  });

  it('rejects an invalid email', async () => {
    const { res } = await quickAdd({ email: 'not-an-email', company: 'X' });
    expect(res.status).toBe(500); // zod parse throws → handler 500s, lead not created
    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, T) });
    expect(rows).toHaveLength(0);
  });
});
