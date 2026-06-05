import { DEFAULT_TABLE_ID, columns, db, leads, sources, tables } from '@fetch/db';
import type { Table } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';
import { ingestLead } from './dedupe';

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

/** The stable id of the protected "Fetch table" example. */
export const EXAMPLE_TABLE_ID = 'tbl_fetch_example';

/** The fixed, undeletable columns of the example table (config.protected). */
const EXAMPLE_COLUMNS = [
  { key: 'company', label: 'Company', type: 'manual', config: { valueType: 'text', protected: true } },
  {
    key: 'ceo_email',
    label: 'CEO email',
    type: 'dogi',
    config: {
      valueType: 'email',
      protected: true,
      instruction: 'Find the CEO or founder’s email address for this company.',
      reads: ['company'],
      output: { mode: 'fill', key: 'ceo_email' },
      sources: [{ type: 'web', via: 'native' }, { type: 'llm' }],
      policy: 'combine',
    },
  },
  {
    key: 'recent_signal',
    label: 'Recent signal',
    type: 'dogi',
    config: {
      valueType: 'text',
      protected: true,
      instruction: 'Find this company’s most recent funding, launch, or hiring signal.',
      reads: ['company'],
      output: { mode: 'fill', key: 'recent_signal' },
      sources: [{ type: 'web', via: 'native' }, { type: 'llm' }],
      policy: 'combine',
    },
  },
] as const;

/**
 * Idempotently create the protected "Fetch table" example: a table the operator
 * can explore but not delete, with fixed (also undeletable) columns and a few
 * example leads. Safe to call on every boot and from the seed — every step uses
 * onConflictDoNothing / dedupe so re-running changes nothing.
 */
export async function ensureExampleTable(): Promise<string> {
  await db
    .insert(tables)
    .values({
      id: EXAMPLE_TABLE_ID,
      name: 'Fetch table',
      description: 'An example table to explore Fetch.',
      settings: { protected: true },
    })
    .onConflictDoNothing();

  for (let i = 0; i < EXAMPLE_COLUMNS.length; i++) {
    const col = EXAMPLE_COLUMNS[i]!;
    await db
      .insert(columns)
      .values({ tableId: EXAMPLE_TABLE_ID, position: i, ...col, config: { ...col.config } })
      .onConflictDoNothing();
  }

  // Example leads — dedupe on email keeps re-runs idempotent.
  const existing = await db.query.leads.findFirst({ where: eq(leads.tableId, EXAMPLE_TABLE_ID) });
  if (!existing) {
    const [source] = await db
      .insert(sources)
      .values({ type: 'manual', raw: { example: true } })
      .returning();
    const examples = [
      { email: 'hello@acme.com', company: 'Acme' },
      { email: 'team@globex.io', company: 'Globex' },
      { email: 'founders@initech.com', company: 'Initech' },
    ];
    for (const ex of examples) {
      await ingestLead(
        { email: ex.email, company: { name: ex.company }, data: { company: ex.company } },
        { sourceId: source!.id, tableId: EXAMPLE_TABLE_ID, actor: 'seed' },
      );
    }
  }

  return EXAMPLE_TABLE_ID;
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
