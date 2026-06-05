import { Hono } from 'hono';
import { z } from 'zod';
import { CsvNormalizer, ManualNormalizer, readCsvHeaders } from '@fetch/connectors';
import { enqueue, ingestLead } from '@fetch/core';
import { DEFAULT_TABLE_ID, db, leads, sources } from '@fetch/db';
import { desc, eq } from 'drizzle-orm';
import { getColumn, validateCellValue, valueTypeOf } from '@fetch/columns';

/**
 * /leads — the table's data API.
 *
 * Import and create go through the SAME ingestion path (normalize → dedupe →
 * persist → enqueue), so a CSV row and a manual entry produce identical leads.
 * The route writes the row and enqueues follow-up jobs; it never enriches or
 * validates inline (that's the worker's job).
 */
export const leadsRoutes = new Hono();

/** List leads for the table, newest first. */
leadsRoutes.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 200);
  const rows = await db.query.leads.findMany({
    orderBy: [desc(leads.createdAt)],
    limit: Math.min(limit, 1000),
  });
  return c.json({ leads: rows });
});

/** Fetch one lead with its full state. */
leadsRoutes.get('/:id', async (c) => {
  const row = await db.query.leads.findFirst({ where: eq(leads.id, c.req.param('id')) });
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ lead: row });
});

const manualSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  linkedinUrl: z.string().optional(),
  company: z.string().optional(),
  domain: z.string().optional(),
});

/** Create one lead manually. Enqueues validation when an email is present. */
leadsRoutes.post('/', async (c) => {
  const body = manualSchema.parse(await c.req.json());

  const [source] = await db
    .insert(sources)
    .values({ type: 'manual', raw: body })
    .returning();

  const canonical = new ManualNormalizer().normalize({
    'first name': body.firstName ?? '',
    'last name': body.lastName ?? '',
    email: body.email ?? '',
    phone: body.phone ?? '',
    title: body.title ?? '',
    linkedin: body.linkedinUrl ?? '',
    company: body.company ?? '',
    domain: body.domain ?? '',
  });

  // Legacy single-table endpoint — targets the default table.
  const { lead, created } = await ingestLead(canonical, {
    sourceId: source!.id,
    tableId: DEFAULT_TABLE_ID,
    actor: 'user',
  });
  if (created && lead.email) await enqueue('validate', { leadId: lead.id });

  return c.json({ lead, created }, created ? 201 : 200);
});

/** Preview CSV headers so the UI can offer a column-mapping step. */
leadsRoutes.post('/import/preview', async (c) => {
  const { csv } = z.object({ csv: z.string() }).parse(await c.req.json());
  return c.json({ headers: readCsvHeaders(csv) });
});

const importSchema = z.object({
  csv: z.string(),
  /** Optional explicit header→field overrides from the mapping UI. */
  map: z.record(z.string()).optional(),
});

/**
 * Bulk CSV import. Stores the raw payload, normalizes + dedupes every row, and
 * enqueues validation for new leads with an email. A no-email row imports fine
 * (status: no_email) without crashing the batch.
 */
leadsRoutes.post('/import', async (c) => {
  const { csv, map } = importSchema.parse(await c.req.json());

  const [source] = await db
    .insert(sources)
    .values({ type: 'csv', raw: { bytes: csv.length } })
    .returning();

  const canonicalLeads = new CsvNormalizer((map as any) ?? {}).normalize(csv);

  let createdCount = 0;
  let mergedCount = 0;
  const ids: string[] = [];

  for (const canonical of canonicalLeads) {
    try {
      const { lead, created } = await ingestLead(canonical, {
        sourceId: source!.id,
        tableId: DEFAULT_TABLE_ID,
        actor: 'user',
      });
      ids.push(lead.id);
      if (created) {
        createdCount++;
        if (lead.email) await enqueue('validate', { leadId: lead.id });
      } else {
        mergedCount++;
      }
    } catch {
      // One bad row must never sink the whole import.
      continue;
    }
  }

  return c.json({ imported: createdCount, merged: mergedCount, total: canonicalLeads.length, ids });
});

const cellEditSchema = z.object({ key: z.string(), value: z.unknown() });

/**
 * Inline-edit a cell (no job). Writes straight into leads.data. When the target
 * column declares a typed value (config.valueType email/number/url/date/…), the
 * value is validated and lightly coerced first — an invalid value is a 400, a
 * valid one persists (possibly coerced, e.g. "42" → 42). Editing a computed
 * cell overrides it (Clay-style), so any field is correctable by hand.
 */
leadsRoutes.patch('/:id/cell', async (c) => {
  const id = c.req.param('id');
  const { key, value } = cellEditSchema.parse(await c.req.json());
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) return c.json({ error: 'not found' }, 404);

  // Look up the column by the lead's table + key to learn its value type.
  let toStore = value;
  const column = await getColumn(lead.tableId, key);
  if (column) {
    const result = validateCellValue(valueTypeOf(column.config), value, column.config);
    if (!result.ok) return c.json({ error: result.error }, 400);
    toStore = result.value;
  }

  const data = { ...(lead.data as object), [key]: toStore };
  const [updated] = await db.update(leads).set({ data }).where(eq(leads.id, id)).returning();
  return c.json({ lead: updated });
});

/** Run a single column's job for one lead (the click-a-cell trigger). */
leadsRoutes.post('/:id/run/:columnKey', async (c) => {
  const leadId = c.req.param('id');
  const columnKey = c.req.param('columnKey');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return c.json({ error: 'lead not found' }, 404);

  // The column is scoped to the lead's table.
  const column = await getColumn(lead.tableId, columnKey);
  if (!column) return c.json({ error: 'unknown column' }, 404);

  if (column.type === 'manual') {
    return c.json({ error: 'manual columns are edited inline, not run' }, 400);
  }
  // dogi | formula resolve in the worker via the enrich queue.
  const jobId = await enqueue('enrich', { leadId, columnKey }, { leadId });
  return c.json({ jobId }, 202);
});

/** Approve / reject a lead's personalized copy. */
const approvalSchema = z.object({ status: z.enum(['approved', 'rejected']) });
leadsRoutes.post('/:id/approval', async (c) => {
  const id = c.req.param('id');
  const { status } = approvalSchema.parse(await c.req.json());
  const [updated] = await db
    .update(leads)
    .set({ approvalStatus: status })
    .where(eq(leads.id, id))
    .returning();
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ lead: updated });
});
