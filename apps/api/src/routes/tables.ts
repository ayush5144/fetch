import { Hono } from 'hono';
import { z } from 'zod';
import { columns as columnsTable, db, jobs, leads, sources, tables } from '@fetch/db';
import { audit, enqueue, ingestLead, listTablesWithCounts } from '@fetch/core';
import { getColumn, planRun, runFormulaColumn } from '@fetch/columns';
import {
  CsvNormalizer,
  identityFieldFor,
  parseCsvRecords,
  previewCsv,
  recordToCanonicalWithMapping,
  snakeCase,
} from '@fetch/connectors';
import type { ImportMapping } from '@fetch/connectors';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

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
  const existing = await db.query.tables.findFirst({ where: eq(tables.id, id) });
  if (!existing) return c.json({ error: 'not found' }, 404);
  if ((existing.settings as { protected?: boolean } | null)?.protected) {
    return c.json({ error: 'the example table cannot be deleted' }, 403);
  }
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
    // Grid order: explicit position first, created_at as a stable tiebreak.
    orderBy: [asc(leads.position), asc(leads.createdAt)],
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

/**
 * Preview a CSV for the import-mapping step: parse the header row and the first
 * data row so the UI can let the operator map each header to a column.
 */
tablesRoutes.post('/:id/import/preview', async (c) => {
  const { csv } = z.object({ csv: z.string() }).parse(await c.req.json());
  return c.json(previewCsv(csv));
});

const importMappingSchema = z
  .object({
    action: z.enum(['create', 'map', 'skip']),
    key: z.string().optional(),
    label: z.string().optional(),
    type: z.string().optional(),
    valueType: z.string().optional(),
  })
  .strict();

const importSchema = z.object({
  csv: z.string(),
  mapping: z.record(importMappingSchema).optional(),
});

/**
 * CSV import into a table.
 *
 * With no `mapping`, behaves as before: identity headers → system fields, and
 * other headers flow into `leads.data` (a blank table auto-creates a column for
 * each; a table with columns auto-maps matching headers and creates the rest).
 *
 * With a `mapping`, each non-identity header is `create`d (ensuring a column
 * exists), `map`ped onto an existing column key, or `skip`ped. Identity headers
 * always normalize to system fields. Dedupe, audit, and validation-enqueue are
 * unchanged.
 */
tablesRoutes.post('/:id/leads/import', async (c) => {
  const tableId = c.req.param('id');
  const { csv, mapping: rawMapping } = importSchema.parse(await c.req.json());
  const [source] = await db.insert(sources).values({ type: 'csv', raw: { bytes: csv.length } }).returning();

  const records = parseCsvRecords(csv);
  const headers = Object.keys(records[0] ?? {}).map((h) => h.trim());
  const nonIdentity = headers.filter((h) => !identityFieldFor(h));

  // Existing user columns in this table, by key and by label (for auto-mapping).
  const existingCols = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const byKey = new Map(existingCols.map((c) => [c.key, c]));
  const byLabel = new Map(existingCols.map((c) => [c.label.toLowerCase(), c]));

  // Build the effective mapping. When none is supplied, derive it from the
  // table's current shape (blank → create all; populated → map matches, create
  // the rest) to preserve the prior no-mapping behavior.
  const mapping: ImportMapping = {};
  if (rawMapping) {
    Object.assign(mapping, rawMapping);
  } else {
    for (const header of nonIdentity) {
      const match = byKey.get(header) ?? byLabel.get(header.toLowerCase());
      mapping[header] = match
        ? { action: 'map', key: match.key }
        : { action: 'create', label: header };
    }
  }

  // Ensure a column definition exists for every `create` header (idempotent).
  for (const header of nonIdentity) {
    const m = mapping[header];
    if (!m || m.action !== 'create') continue;
    const key = (m.key && m.key.trim()) || snakeCase(header);
    if (byKey.has(key)) continue; // already there → just write values into it
    const label = m.label?.trim() || header;
    const type = m.type?.trim() || 'manual';
    const valueType = m.valueType?.trim() || 'text';
    try {
      const [created] = await db
        .insert(columnsTable)
        .values({ tableId, key, label, type, config: { valueType } })
        .returning();
      byKey.set(key, created!);
      await audit({ entity: 'column', entityId: created!.id, action: 'create', diff: { key } });
    } catch {
      // A concurrent create or a label clash — the values still land in data[key].
    }
  }

  let imported = 0;
  let merged = 0;
  for (const record of records) {
    try {
      const canonical = recordToCanonicalWithMapping(record, mapping);
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
  return c.json({ imported, merged, total: records.length });
});

// ── Columns within a table ────────────────────────────────────────────────────

tablesRoutes.get('/:id/columns', async (c) => {
  const id = c.req.param('id');
  const rows = await db.query.columns.findMany({
    where: eq(columnsTable.tableId, id),
    // Grid order: explicit position first, created_at as a stable tiebreak.
    orderBy: [asc(columnsTable.position), asc(columnsTable.createdAt)],
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
  } catch {
    // The unique (table_id, key)/(table_id, label) indexes enforce no dup names.
    return c.json({ error: 'a column with that name or key already exists in this table' }, 409);
  }
});

const runSchema = z.object({
  leadIds: z.array(z.string()).default([]),
  force: z.boolean().default(false),
  /** Optional BYOK key for this run; passed to the job, never persisted. */
  apiKey: z.string().optional(),
});

tablesRoutes.post('/:id/columns/:key/run', async (c) => {
  const tableId = c.req.param('id');
  const key = c.req.param('key');
  const { leadIds, force, apiKey } = runSchema.parse(await c.req.json().catch(() => ({})));

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
    jobIds.push(
      await enqueue('enrich', { leadId: lead.id, columnKey: key, apiKey }, { leadId: lead.id }),
    );
  }
  return c.json({ type: plan.column.type, enqueued: jobIds.length, skipped: plan.skipped }, 202);
});

// ── Reordering (drag-to-reorder columns & rows) ───────────────────────────────

const reorderSchema = z.object({ order: z.array(z.string()) });

/**
 * Persist a new column order. `order` is the column ids left→right; each gets a
 * `position` equal to its index. Only columns that belong to this table are
 * touched (ids from other tables are ignored). One UPDATE per id, scoped by
 * table_id so a stray id can never write across tables.
 */
tablesRoutes.post('/:id/columns/reorder', async (c) => {
  const tableId = c.req.param('id');
  const { order } = reorderSchema.parse(await c.req.json());
  await db.transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      await tx
        .update(columnsTable)
        .set({ position: i })
        .where(and(eq(columnsTable.id, order[i]!), eq(columnsTable.tableId, tableId)));
    }
  });
  return c.json({ ok: true });
});

/**
 * Persist a new row order. `order` is the lead ids top→bottom; each gets a
 * `position` equal to its index. Scoped to this table.
 */
tablesRoutes.post('/:id/leads/reorder', async (c) => {
  const tableId = c.req.param('id');
  const { order } = reorderSchema.parse(await c.req.json());
  await db.transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      await tx
        .update(leads)
        .set({ position: i })
        .where(and(eq(leads.id, order[i]!), eq(leads.tableId, tableId)));
    }
  });
  return c.json({ ok: true });
});

/**
 * Duplicate a column: copy its type/config/width with a fresh, unique key+label
 * (appending `_copy`, then `_copy2`, … until free). The copy lands at the end of
 * the grid (max position + 1). Values already in leads.data aren't copied — a
 * Dogi/formula copy refills; a manual copy starts blank.
 */
tablesRoutes.post('/:id/columns/:key/duplicate', async (c) => {
  const tableId = c.req.param('id');
  const key = c.req.param('key');

  const src = await getColumn(tableId, key);
  if (!src) return c.json({ error: 'unknown column' }, 404);

  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const usedKeys = new Set(existing.map((x) => x.key));
  const usedLabels = new Set(existing.map((x) => x.label));
  const maxPos = existing.reduce((m, x) => Math.max(m, x.position), -1);

  // Find a free `<key>_copy` / `<label> (copy)` pair, bumping a counter on clash.
  let n = 0;
  let newKey = `${src.key}_copy`;
  let newLabel = `${src.label}_copy`;
  while (usedKeys.has(newKey) || usedLabels.has(newLabel)) {
    n += 1;
    newKey = `${src.key}_copy${n}`;
    newLabel = `${src.label}_copy${n}`;
  }

  const [created] = await db
    .insert(columnsTable)
    .values({
      tableId,
      key: newKey,
      label: newLabel,
      type: src.type,
      config: src.config as object,
      width: src.width,
      position: maxPos + 1,
    })
    .returning();
  await audit({ entity: 'column', entityId: created!.id, action: 'create', diff: { key: newKey, from: src.key } });
  return c.json({ column: created }, 201);
});

// ── Cell jobs (running/queued cell states for the grid) ───────────────────────

/**
 * Non-terminal enrich jobs for this table, so the grid can paint queued/running
 * cells. We join jobs → leads by table and read the column key out of the job's
 * stored payload. Only queued/active (non-terminal) jobs of type `enrich`.
 */
tablesRoutes.get('/:id/cell-jobs', async (c) => {
  const tableId = c.req.param('id');
  const rows = await db
    .select({
      leadId: jobs.leadId,
      columnKey: sql<string>`${jobs.payload}->>'columnKey'`,
      status: jobs.status,
    })
    .from(jobs)
    .innerJoin(leads, eq(jobs.leadId, leads.id))
    .where(
      and(
        eq(leads.tableId, tableId),
        eq(jobs.type, 'enrich'),
        inArray(jobs.status, ['queued', 'active']),
      ),
    );
  return c.json({ jobs: rows.filter((r) => r.leadId && r.columnKey) });
});
