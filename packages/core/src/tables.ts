import { DEFAULT_TABLE_ID, db, tables } from '@fetch/db';
import type { Table } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';

/**
 * Table helpers. A workspace holds many tables (Phase A); each owns its columns
 * and leads. The default table is guaranteed to exist so single-table callers
 * (seed, simple imports) always have somewhere to put rows.
 */

/** Ensure the default "Leads" table exists; returns its id. Idempotent. */
export async function ensureDefaultTable(): Promise<string> {
  await db
    .insert(tables)
    .values({ id: DEFAULT_TABLE_ID, name: 'Leads', description: 'Default table' })
    .onConflictDoNothing();
  return DEFAULT_TABLE_ID;
}

/** A table with its live row/column counts, for the Overview cards. */
export interface TableWithCounts extends Table {
  leadCount: number;
  columnCount: number;
}

export async function listTablesWithCounts(): Promise<TableWithCounts[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    settings: unknown;
    created_at: Date;
    updated_at: Date;
    lead_count: number;
    column_count: number;
  }>(sql`
    SELECT t.*,
      (SELECT count(*) FROM leads l WHERE l.table_id = t.id)::int AS lead_count,
      (SELECT count(*) FROM columns c WHERE c.table_id = t.id)::int AS column_count
    FROM tables t
    ORDER BY t.created_at ASC
  `);
  const list = (rows.rows ?? rows) as any[];
  return list.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    settings: r.settings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    leadCount: Number(r.lead_count),
    columnCount: Number(r.column_count),
  }));
}

export async function getTable(id: string): Promise<Table | undefined> {
  return db.query.tables.findFirst({ where: eq(tables.id, id) });
}
