import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, leads, tables } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { audit, startQueues, stopQueues } from '@fetch/core';
import { app } from '../src/app';

/**
 * G.2a + G.2c — backend slices.
 *
 * G.2a: creating a table via `POST /tables` seeds exactly ONE blank, editable
 * lead so the grid opens on row 1 instead of a dead end.
 *
 * G.2c: `GET /activity` is a paginated, newest-first feed over `audit_log`.
 */

beforeAll(async () => {
  await startQueues();
});
afterAll(async () => {
  await stopQueues();
});

describe('G.2a — fresh table seeds one blank row', () => {
  beforeEach(truncateAll);

  it('POST /tables seeds exactly one empty, editable lead', async () => {
    const res = await app.request('/tables', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Seed Test' }),
    });
    expect(res.status).toBe(201);
    const { table } = await res.json();

    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, table.id) });
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    // Empty / editable: no email, blank data, not-sendable status.
    expect(row.email).toBeNull();
    expect(row.data).toEqual({});
    expect(row.validationStatus).toBe('no_email');

    // The grid endpoint returns the same single row.
    const grid = await (await app.request(`/tables/${table.id}/leads`)).json();
    expect(grid.leads).toHaveLength(1);
    expect(grid.leads[0].id).toBe(row.id);
  });

  it('is idempotent — re-seeding an already-populated table adds no rows', async () => {
    const { seedBlankLead } = await import('@fetch/core');
    const [t] = await db.insert(tables).values({ name: 'Idem' }).returning();

    const first = await seedBlankLead(t!.id, 'user');
    expect(first).not.toBeNull();
    const second = await seedBlankLead(t!.id, 'user');
    expect(second).toBeNull();

    const rows = await db.query.leads.findMany({ where: eq(leads.tableId, t!.id) });
    expect(rows).toHaveLength(1);
  });
});

describe('G.2c — GET /activity feed over audit_log', () => {
  beforeEach(truncateAll);

  it('returns rows newest-first with the AuditRow shape and a total', async () => {
    await audit({ actor: 'user', entity: 'lead', entityId: 'l1', action: 'create', diff: { a: 1 } });
    await audit({ actor: 'system', entity: 'column', entityId: 'c1', action: 'create', diff: { key: 'x' } });

    const res = await app.request('/activity');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(2);
    expect(body.activity).toHaveLength(2);
    // Newest first: the column create was written last.
    expect(body.activity[0].entity).toBe('column');
    expect(body.activity[0].entityId).toBe('c1');

    const row = body.activity[0];
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'actor', 'createdAt', 'diff', 'entity', 'entityId', 'id'].sort(),
    );
    expect(row.diff).toEqual({ key: 'x' });
  });

  it('paginates with limit/offset', async () => {
    for (let i = 0; i < 5; i++) {
      await audit({ entity: 'lead', entityId: `l${i}`, action: 'create', diff: { i } });
    }

    const page1 = await (await app.request('/activity?limit=2&offset=0')).json();
    expect(page1.total).toBe(5);
    expect(page1.activity).toHaveLength(2);
    expect(page1.activity[0].entityId).toBe('l4'); // newest

    const page2 = await (await app.request('/activity?limit=2&offset=2')).json();
    expect(page2.activity).toHaveLength(2);
    expect(page2.activity[0].entityId).toBe('l2');

    // No overlap between pages.
    const ids1 = page1.activity.map((r: any) => r.id);
    const ids2 = page2.activity.map((r: any) => r.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('clamps an over-large limit to the max (200) instead of erroring', async () => {
    // Write 201 rows so a clamp to 200 is observable.
    for (let i = 0; i < 201; i++) {
      await audit({ entity: 'lead', entityId: `l${i}`, action: 'create', diff: { i } });
    }
    const res = await app.request('/activity?limit=9999');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(201);
    expect(body.activity).toHaveLength(200); // clamped, not 201, not a 400
  });
});
