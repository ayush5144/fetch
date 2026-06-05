import { Hono } from 'hono';
import { z } from 'zod';
import { db, columns as columnsTable } from '@fetch/db';
import { audit, enqueue } from '@fetch/core';
import { planRun, runFormulaColumn } from '@fetch/columns';
import { asc, eq } from 'drizzle-orm';

/**
 * /columns — CRUD for the dynamic column engine, plus "run column".
 *
 * Running a column is the fan-out: planRun applies run-only-if-empty and returns
 * exactly the leads that need work, then we enqueue ONE enrich job per row
 * (enrichment/agent) — or recompute inline (formula). The job count therefore
 * matches the filtered selection, never the whole table by accident.
 */
export const columnsRoutes = new Hono();

columnsRoutes.get('/', async (c) => {
  const rows = await db.query.columns.findMany({ orderBy: [asc(columnsTable.createdAt)] });
  return c.json({ columns: rows });
});

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, 'key must be snake_case (a-z, 0-9, _)'),
  label: z.string().min(1),
  type: z.enum(['enrichment', 'agent', 'formula', 'manual']),
  config: z.record(z.unknown()).default({}),
});

columnsRoutes.post('/', async (c) => {
  const body = createSchema.parse(await c.req.json());
  const [created] = await db.insert(columnsTable).values(body).returning();
  await audit({ entity: 'column', entityId: created!.id, action: 'create', diff: { key: body.key } });
  return c.json({ column: created }, 201);
});

columnsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const patch = createSchema.partial().parse(await c.req.json());
  const [updated] = await db
    .update(columnsTable)
    .set(patch)
    .where(eq(columnsTable.id, id))
    .returning();
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ column: updated });
});

/** Delete a column definition. Existing values stay in leads.data untouched. */
columnsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
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

  const plan = await planRun(key, leadIds, { force });
  if (!plan) return c.json({ error: 'unknown column' }, 404);

  // Formula columns are derived locally — no jobs, recompute right here.
  if (plan.column.type === 'formula') {
    const updated = await runFormulaColumn(key, plan.toRun.map((l) => l.id));
    return c.json({ type: 'formula', updated, skipped: plan.skipped });
  }

  // Manual columns are never "run".
  if (plan.column.type === 'manual') {
    return c.json({ error: 'manual columns are edited inline' }, 400);
  }

  // enrichment | agent → one enrich job per row that needs filling.
  const jobIds: string[] = [];
  for (const lead of plan.toRun) {
    jobIds.push(await enqueue('enrich', { leadId: lead.id, columnKey: key }, { leadId: lead.id }));
  }
  return c.json({ type: plan.column.type, enqueued: jobIds.length, skipped: plan.skipped }, 202);
});
