import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, columns, db, leads, tables } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { EXAMPLE_TABLE_ID, ensureExampleTable } from '@fetch/core';
import { app } from '../src/app';

/**
 * Phase B.1 — CSV import with column mapping + the protected example table.
 * Talks to the disposable test DB through the real Hono app.
 */

const T = DEFAULT_TABLE_ID;

async function ensureTable(id: string, name = 'Test') {
  await db.insert(tables).values({ id, name }).onConflictDoNothing();
}

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /tables/:id/import/preview', () => {
  beforeEach(truncateAll);

  it('returns headers and the first data row keyed by header', async () => {
    await ensureTable(T);
    const csv = 'company,ceo_email,headcount\nAcme,ava@acme.com,240\nGlobex,n@globex.io,12';
    const res = await post(`/tables/${T}/import/preview`, { csv });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headers).toEqual(['company', 'ceo_email', 'headcount']);
    expect(body.sample).toEqual({ company: 'Acme', ceo_email: 'ava@acme.com', headcount: '240' });
  });
});

describe('POST /tables/:id/leads/import — mapping', () => {
  beforeEach(truncateAll);

  it('create: ensures a new column and writes values into leads.data[key]', async () => {
    await ensureTable(T);
    const csv = 'email,Head Count\nava@acme.com,240';
    const res = await post(`/tables/${T}/leads/import`, {
      csv,
      mapping: {
        'Head Count': { action: 'create', label: 'Head count', type: 'manual', valueType: 'number' },
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).imported).toBe(1);

    const col = await db.query.columns.findFirst({
      where: eq(columns.tableId, T),
    });
    expect(col!.key).toBe('head_count'); // snake_case(header)
    expect(col!.label).toBe('Head count');
    expect((col!.config as any).valueType).toBe('number');

    const lead = await db.query.leads.findFirst({ where: eq(leads.tableId, T) });
    expect(lead!.email).toBe('ava@acme.com');
    expect((lead!.data as any).head_count).toBe('240');
  });

  it('map: writes a header into an existing column key, skip ignores a header', async () => {
    await ensureTable(T);
    await db.insert(columns).values({ tableId: T, key: 'size', label: 'Size', type: 'manual', config: {} });
    const csv = 'email,Headcount,Notes\nava@acme.com,240,ignore me';
    await post(`/tables/${T}/leads/import`, {
      csv,
      mapping: {
        Headcount: { action: 'map', key: 'size' },
        Notes: { action: 'skip' },
      },
    });

    // No new column was created (only the pre-existing `size`).
    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    expect(cols.map((c) => c.key)).toEqual(['size']);

    const lead = await db.query.leads.findFirst({ where: eq(leads.tableId, T) });
    expect((lead!.data as any).size).toBe('240');
    expect((lead!.data as any).Notes).toBeUndefined();
  });

  it('identity headers still normalize to system fields even with a mapping', async () => {
    await ensureTable(T);
    const csv = 'email,company,Stage\nava@acme.com,Acme,Series B';
    await post(`/tables/${T}/leads/import`, {
      csv,
      mapping: { Stage: { action: 'create', label: 'Stage' } },
    });
    const lead = await db.query.leads.findFirst({ where: eq(leads.tableId, T) });
    expect(lead!.email).toBe('ava@acme.com');
    expect((lead!.data as any).Stage).toBeUndefined();
    expect((lead!.data as any).stage).toBe('Series B');
  });

  it('no mapping on a blank table auto-creates a column for each non-identity header', async () => {
    await ensureTable(T);
    const csv = 'email,Industry,Region\nava@acme.com,SaaS,EU';
    await post(`/tables/${T}/leads/import`, { csv });

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    expect(cols.map((c) => c.key).sort()).toEqual(['industry', 'region']);

    const lead = await db.query.leads.findFirst({ where: eq(leads.tableId, T) });
    // Auto-created columns use snake_case(header) as their data key.
    expect((lead!.data as any).industry).toBe('SaaS');
    expect((lead!.data as any).region).toBe('EU');
  });

  it('no mapping on a populated table auto-maps matching headers and creates the rest', async () => {
    await ensureTable(T);
    await db
      .insert(columns)
      .values({ tableId: T, key: 'industry', label: 'Industry', type: 'manual', config: {} });
    const csv = 'email,Industry,Region\nava@acme.com,SaaS,EU';
    await post(`/tables/${T}/leads/import`, { csv });

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, T) });
    expect(cols.map((c) => c.key).sort()).toEqual(['industry', 'region']);
    // The matching header maps onto the existing key (no duplicate column).
    expect(cols.filter((c) => c.key === 'industry')).toHaveLength(1);
  });
});

describe('protected example table & columns', () => {
  beforeEach(truncateAll);

  it('ensureExampleTable creates a protected table with fixed protected columns and example leads', async () => {
    await ensureExampleTable();
    const tbl = await db.query.tables.findFirst({ where: eq(tables.id, EXAMPLE_TABLE_ID) });
    expect(tbl!.name).toBe('Fetch table');
    expect((tbl!.settings as any).protected).toBe(true);

    const cols = await db.query.columns.findMany({ where: eq(columns.tableId, EXAMPLE_TABLE_ID) });
    expect(cols.map((c) => c.key).sort()).toEqual(['ceo_email', 'company', 'recent_signal']);
    expect(cols.every((c) => (c.config as any).protected === true)).toBe(true);

    const exampleLeads = await db.query.leads.findMany({ where: eq(leads.tableId, EXAMPLE_TABLE_ID) });
    expect(exampleLeads.length).toBeGreaterThanOrEqual(2);

    // Idempotent: a second call adds nothing.
    await ensureExampleTable();
    const colsAgain = await db.query.columns.findMany({ where: eq(columns.tableId, EXAMPLE_TABLE_ID) });
    expect(colsAgain).toHaveLength(cols.length);
    const leadsAgain = await db.query.leads.findMany({ where: eq(leads.tableId, EXAMPLE_TABLE_ID) });
    expect(leadsAgain).toHaveLength(exampleLeads.length);
  });

  it('DELETE /tables/:id returns 403 for the protected example table', async () => {
    await ensureExampleTable();
    const res = await app.request(`/tables/${EXAMPLE_TABLE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/example table cannot be deleted/i);
    // Still there.
    const tbl = await db.query.tables.findFirst({ where: eq(tables.id, EXAMPLE_TABLE_ID) });
    expect(tbl).toBeTruthy();
  });

  it('DELETE /columns/:id returns 403 for a protected column', async () => {
    await ensureExampleTable();
    const col = await db.query.columns.findFirst({
      where: eq(columns.tableId, EXAMPLE_TABLE_ID),
    });
    const res = await app.request(`/columns/${col!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    const still = await db.query.columns.findFirst({ where: eq(columns.id, col!.id) });
    expect(still).toBeTruthy();
  });

  it('a normal table and a normal column delete as usual', async () => {
    const [tbl] = await db.insert(tables).values({ name: 'Normal' }).returning();
    const [col] = await db
      .insert(columns)
      .values({ tableId: tbl!.id, key: 'note', label: 'Note', type: 'manual', config: {} })
      .returning();

    const delCol = await app.request(`/columns/${col!.id}`, { method: 'DELETE' });
    expect(delCol.status).toBe(200);

    const delTbl = await app.request(`/tables/${tbl!.id}`, { method: 'DELETE' });
    expect(delTbl.status).toBe(200);
    const gone = await db.query.tables.findFirst({ where: eq(tables.id, tbl!.id) });
    expect(gone).toBeUndefined();
  });
});
