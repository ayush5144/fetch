import { beforeEach, describe, expect, it } from 'vitest';
import { columns, db, leads, sources, tables } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { ensureDefaultTable, ingestLead, listTablesWithCounts } from '@fetch/core';
import { eq } from 'drizzle-orm';

/**
 * Phase A — multi-table foundation. Proves tables scope leads + columns, that a
 * column key/label is unique per table (not globally), and that counts roll up.
 */
async function mkTable(name: string): Promise<string> {
  const [t] = await db.insert(tables).values({ name }).returning();
  return t!.id;
}
async function mkLead(tableId: string, email: string) {
  const [src] = await db.insert(sources).values({ type: 'csv', raw: {} }).returning();
  return ingestLead(new CsvNormalizer().normalize(`email\n${email}`)[0]!, {
    sourceId: src!.id,
    tableId,
  });
}

describe('multi-table', () => {
  beforeEach(truncateAll);

  it('ensureDefaultTable is idempotent', async () => {
    const a = await ensureDefaultTable();
    const b = await ensureDefaultTable();
    expect(a).toBe(b);
    const rows = await db.query.tables.findMany({ where: eq(tables.id, a) });
    expect(rows).toHaveLength(1);
  });

  it('scopes leads to their table', async () => {
    const t1 = await mkTable('A');
    const t2 = await mkTable('B');
    await mkLead(t1, 'x@a.com');
    await mkLead(t2, 'y@b.com');

    const inT1 = await db.query.leads.findMany({ where: eq(leads.tableId, t1) });
    expect(inT1).toHaveLength(1);
    expect(inT1[0]!.email).toBe('x@a.com');
  });

  it('lets the same email exist in two different tables (table-scoped dedupe)', async () => {
    const t1 = await mkTable('A');
    const t2 = await mkTable('B');
    const a = await mkLead(t1, 'dup@x.com');
    const b = await mkLead(t2, 'dup@x.com');
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // not merged across tables
    expect(a.lead.id).not.toBe(b.lead.id);
  });

  it('allows the same column key in two tables but rejects a dup within one', async () => {
    const t1 = await mkTable('A');
    const t2 = await mkTable('B');
    await db.insert(columns).values({ tableId: t1, key: 'company', label: 'Company', type: 'manual' });
    // same key in another table is fine
    await db.insert(columns).values({ tableId: t2, key: 'company', label: 'Company', type: 'manual' });
    // a dup within the SAME table is rejected by the unique index
    await expect(
      db.insert(columns).values({ tableId: t1, key: 'company', label: 'Company 2', type: 'manual' }),
    ).rejects.toThrow();
  });

  it('rolls up lead + column counts per table', async () => {
    const t1 = await mkTable('Counts');
    await mkLead(t1, 'a@x.com');
    await mkLead(t1, 'b@x.com');
    await db.insert(columns).values({ tableId: t1, key: 'note', label: 'Note', type: 'manual' });

    const list = await listTablesWithCounts();
    const row = list.find((t) => t.id === t1)!;
    expect(row.leadCount).toBe(2);
    expect(row.columnCount).toBe(1);
  });
});
