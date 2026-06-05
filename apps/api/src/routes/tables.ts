import { Hono } from 'hono';
import { z } from 'zod';
import { columns as columnsTable, db, leads, sources, tables } from '@fetch/db';
import { audit, enqueue, ingestLead, listTablesWithCounts } from '@fetch/core';
import { planRun, runFormulaColumn } from '@fetch/columns';
import { CsvNormalizer } from '@fetch/connectors';
import { asc, desc, eq } from 'drizzle-orm';

/**
 * /tables — the multi-table surface (Phase A). A workspace holds many tables;
 * each owns its columns and leads. The Overview lists/creates tables, and the
 * grid reads a table's leads + columns from here. Lead-by-id and column-by-id
 * operations stay in their own routers.
 */
export const tablesRoutes = new Hono();

/** List tables with live row/column counts for the Overview cards. */
tablesRoutes.get('/', async (c) => {
  return c.json({ tables: await listTablesWithCounts() });
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
});

tablesRoutes.post('/', async (c) => {
  const body = createSchema.parse(await c.req.json());
  const [created] = await db.insert(tables).values(body).returning();
  await audit({ entity: 'table', entityId: created!.id, action: 'create', diff: { name: body.name } });
  return c.json({ table: created }, 201);
});

tablesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const patch = createSchema.partial().parse(await c.req.json());
  const [updated] = await db.update(tables).set(patch).where(eq(tables.id, id)).returning();
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ table: updated });
});

tablesRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(tables).where(eq(tables.id, id)).returning();
  if (!deleted) return c.json({ error: 'not found' }, 404);
  await audit({ entity: 'table', entityId: id, action: 'delete', diff: { name: deleted.name } });
  return c.json({ ok: true });
});

// ── Leads within a table ──────────────────────────────────────────────────────

tablesRoutes.get('/:id/leads', async (c) => {
  const id = c.req.param('id');
  const rows = await db.query.leads.findMany({
    where: eq(leads.tableId, id),
    orderBy: [desc(leads.createdAt)],
    limit: 1000,
  });
  return c.json({ leads: rows });
});

const manualLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  domain: z.string().optional(),
});

/** Create one blank/manual lead in a table (the grid's "+ new lead"). */
tablesRoutes.post('/:id/leads', async (c) => {
  const tableId = c.req.param('id');
  const body = manualLeadSchema.parse(await c.req.json().catch(() => ({})));
  const [source] = await db.insert(sources).values({ type: 'manual', raw: body }).returning();

  const canonical = new CsvNormalizer().normalize(
    `first_name,last_name,email,title,company\n${[body.firstName, body.lastName, body.email, body.title, body.company]
      .map((v) => (v ?? '').replace(/,/g, ' '))
      .join(',')}`,
  )[0]!;

  const { lead, created } = await ingestLead(canonical, { sourceId: source!.id, tableId, actor: 'user' });
  if (created && lead.email) await enqueue('validate', { leadId: lead.id });
  return c.json({ lead, created }, created ? 201 : 200);
});

/** CSV import into a table. */
tablesRoutes.post('/:id/leads/import', async (c) => {
  const tableId = c.req.param('id');
  const { csv } = z.object({ csv: z.string() }).parse(await c.req.json());
  const [source] = await db.insert(sources).values({ type: 'csv', raw: { bytes: csv.length } }).returning();

  const canonicalLeads = new CsvNormalizer().normalize(csv);
  let imported = 0;
  let merged = 0;
  for (const canonical of canonicalLeads) {
    try {
      const { lead, created } = await ingestLead(canonical, { sourceId: source!.id, tableId, actor: 'user' });
      if (created) {
        imported++;
        if (lead.email) await enqueue('validate', { leadId: lead.id });
      } else {
        merged++;
      }
    } catch {
      continue; // one bad row never sinks the import
    }
  }
  return c.json({ imported, merged, total: canonicalLeads.length });
});

// ── Columns within a table ────────────────────────────────────────────────────

tablesRoutes.get('/:id/columns', async (c) => {
  const id = c.req.param('id');
  const rows = await db.query.columns.findMany({
    where: eq(columnsTable.tableId, id),
    orderBy: [asc(columnsTable.createdAt)],
  });
  return c.json({ columns: rows });
});

const columnSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, 'key must be snake_case (a-z, 0-9, _)'),
  label: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()).default({}),
});

tablesRoutes.post('/:id/columns', async (c) => {
  const tableId = c.req.param('id');
  const body = columnSchema.parse(await c.req.json());
  try {
    const [created] = await db
      .insert(columnsTable)
      .values({ ...body, tableId })
      .returning();
    await audit({ entity: 'column', entityId: created!.id, action: 'create', diff: { key: body.key } });
    return c.json({ column: created }, 201);
  } catch (err) {
    // The unique (table_id, key)/(table_id, label) indexes enforce no dup names.
    return c.json({ error: 'a column with that name or key already exists in this table' }, 409);
  }
});

const runSchema = z.object({
  leadIds: z.array(z.string()).default([]),
  force: z.boolean().default(false),
});

tablesRoutes.post('/:id/columns/:key/run', async (c) => {
  const tableId = c.req.param('id');
  const key = c.req.param('key');
  const { leadIds, force } = runSchema.parse(await c.req.json().catch(() => ({})));

  const plan = await planRun(tableId, key, leadIds, { force });
  if (!plan) return c.json({ error: 'unknown column' }, 404);

  if (plan.column.type === 'formula') {
    const updated = await runFormulaColumn(tableId, key, plan.toRun.map((l) => l.id));
    return c.json({ type: 'formula', updated, skipped: plan.skipped });
  }
  if (plan.column.type === 'manual') {
    return c.json({ error: 'manual columns are edited inline' }, 400);
  }

  const jobIds: string[] = [];
  for (const lead of plan.toRun) {
    jobIds.push(await enqueue('enrich', { leadId: lead.id, columnKey: key }, { leadId: lead.id }));
  }
  return c.json({ type: plan.column.type, enqueued: jobIds.length, skipped: plan.skipped }, 202);
});
