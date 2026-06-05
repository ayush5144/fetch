import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_TABLE_ID, db, columns as columnsTable } from '@fetch/db';
import { audit, enqueue } from '@fetch/core';
import { planRun, runFormulaColumn } from '@fetch/columns';
import { asc, eq } from 'drizzle-orm';

/**
 * /columns — legacy single-table shims (default table) + column-by-id ops.
 *
 * The canonical, table-scoped column endpoints live under `/tables/:id/columns`
 * (see routes/tables.ts). These keep the current UI working against the default
 * table while the grid is rebuilt (Phase B).
 */
export const columnsRoutes = new Hono();

columnsRoutes.get('/', async (c) => {
  const rows = await db.query.columns.findMany({
    where: eq(columnsTable.tableId, DEFAULT_TABLE_ID),
    orderBy: [asc(columnsTable.createdAt)],
  });
  return c.json({ columns: rows });
});

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, 'key must be snake_case (a-z, 0-9, _)'),
  label: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()).default({}),
});

columnsRoutes.post('/', async (c) => {
  const body = createSchema.parse(await c.req.json());
  const [created] = await db
    .insert(columnsTable)
    .values({ ...body, tableId: DEFAULT_TABLE_ID })
    .returning();
  await audit({ entity: 'column', entityId: created!.id, action: 'create', diff: { key: body.key } });
  return c.json({ column: created }, 201);
});

// PATCH accepts presentation + identity edits. `key`/`type` aren't editable
// here (renaming the JSONB key would orphan stored values); the grid edits
// label/config and persists drag position/width.
const patchSchema = z.object({
  label: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  position: z.number().int().optional(),
  width: z.number().int().nullable().optional(),
});

columnsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const patch = patchSchema.parse(await c.req.json());
  try {
    const [updated] = await db
      .update(columnsTable)
      .set(patch)
      .where(eq(columnsTable.id, id))
      .returning();
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json({ column: updated });
  } catch {
    // The unique (table_id, label) index throws on a duplicate name in the table.
    return c.json({ error: 'a column with that name already exists in this table' }, 409);
  }
});

/** Delete a column definition. Existing values stay in leads.data untouched. */
columnsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.columns.findFirst({ where: eq(columnsTable.id, id) });
  if (!existing) return c.json({ error: 'not found' }, 404);
  if ((existing.config as { protected?: boolean } | null)?.protected) {
    return c.json({ error: 'this column cannot be deleted' }, 403);
  }
  const [deleted] = await db.delete(columnsTable).where(eq(columnsTable.id, id)).returning();
  if (!deleted) return c.json({ error: 'not found' }, 404);
  await audit({ entity: 'column', entityId: id, action: 'delete', diff: { key: deleted.key } });
  return c.json({ ok: true });
});

const runSchema = z.object({
  /** Leads to run over; empty = whole table. */
  leadIds: z.array(z.string()).default([]),
  /** Re-run even if a cell already has a value. */
  force: z.boolean().default(false),
});

columnsRoutes.post('/:key/run', async (c) => {
  const key = c.req.param('key');
  const { leadIds, force } = runSchema.parse(await c.req.json().catch(() => ({})));

  const plan = await planRun(DEFAULT_TABLE_ID, key, leadIds, { force });
  if (!plan) return c.json({ error: 'unknown column' }, 404);

  // Formula columns are derived locally — no jobs, recompute right here.
  if (plan.column.type === 'formula') {
    const updated = await runFormulaColumn(DEFAULT_TABLE_ID, key, plan.toRun.map((l) => l.id));
    return c.json({ type: 'formula', updated, skipped: plan.skipped });
  }

  // Manual columns are never "run".
  if (plan.column.type === 'manual') {
    return c.json({ error: 'manual columns are edited inline' }, 400);
  }

  // dogi → one enrich job per row that needs filling.
  const jobIds: string[] = [];
  for (const lead of plan.toRun) {
    jobIds.push(await enqueue('enrich', { leadId: lead.id, columnKey: key }, { leadId: lead.id }));
  }
  return c.json({ type: plan.column.type, enqueued: jobIds.length, skipped: plan.skipped }, 202);
});
