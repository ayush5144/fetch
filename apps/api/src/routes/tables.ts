import { Hono } from 'hono';
import { z } from 'zod';
import { columns as columnsTable, db, jobs, leads, sources, tables } from '@fetch/db';
import {
  audit,
  dedupeExistingRows,
  enqueue,
  ingestLead,
  insertSourcedRows,
  listTablesWithCounts,
  seedBlankLead,
} from '@fetch/core';
import { getColumn, isCellEmpty, planRun, runFormulaColumn } from '@fetch/columns';
import {
  isSourceRowsStep,
  planDoggo,
  planGoal,
  sourceRows,
  type DogiBrain,
  type DogiPlanStep,
  type DoggoPlanStep,
  type SourceRowsStep,
} from '@fetch/agent';
import { getLLM } from '@fetch/llm';
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
  // A fresh table is never a dead end: seed exactly one blank, editable row so
  // the grid opens on row 1 (G.2a). Idempotent — only seeds when there are no
  // leads yet, never preset content columns.
  await seedBlankLead(created!.id, 'user');
  return c.json({ table: created }, 201);
});

/**
 * Patch a table's name/description/icon and/or its `settings` (e.g.
 * `settings.dedupe`, the per-table dedupe policy — Phase G). `settings` replaces
 * the stored object, so callers pass the full settings they want persisted.
 */
const patchSchema = createSchema.partial().extend({
  settings: z.record(z.unknown()).optional(),
});

tablesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const patch = patchSchema.parse(await c.req.json());
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
  if (created) {
    // Append the new row at the end of the table (one past the current max).
    const [row] = await db
      .select({ maxPos: sql<number>`coalesce(max(${leads.position}), -1)::int` })
      .from(leads)
      .where(eq(leads.tableId, tableId));
    await db.update(leads).set({ position: (row?.maxPos ?? -1) + 1 }).where(eq(leads.id, lead.id));
    if (lead.email) await enqueue('validate', { leadId: lead.id });
  }
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

/** Optional per-import dedupe override (Phase G); else the table's setting wins. */
const dedupePolicySchema = z.object({
  mode: z.enum(['none', 'columns', 'company']),
  keys: z.array(z.string()).optional(),
});

const importSchema = z.object({
  csv: z.string(),
  mapping: z.record(importMappingSchema).optional(),
  dedupe: dedupePolicySchema.optional(),
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
  const { csv, mapping: rawMapping, dedupe } = importSchema.parse(await c.req.json());
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
      const { lead, created } = await ingestLead(canonical, {
        sourceId: source!.id,
        tableId,
        actor: 'user',
        dedupe,
      });
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

const bulkDeleteSchema = z.object({ leadIds: z.array(z.string()).default([]) });

/**
 * Bulk-delete leads from a table. Only leads that actually belong to this table
 * are removed — ids pointing at other tables are ignored, so a table-scoped
 * call can never reach across tables. Events/jobs cascade via FK. Audited.
 */
tablesRoutes.post('/:id/leads/delete', async (c) => {
  const tableId = c.req.param('id');
  const { leadIds } = bulkDeleteSchema.parse(await c.req.json().catch(() => ({})));
  if (leadIds.length === 0) return c.json({ deleted: 0 });

  const deleted = await db
    .delete(leads)
    .where(and(eq(leads.tableId, tableId), inArray(leads.id, leadIds)))
    .returning({ id: leads.id, email: leads.email });

  for (const row of deleted) {
    await audit({ entity: 'lead', entityId: row.id, action: 'delete', diff: { email: row.email, tableId } });
  }
  return c.json({ deleted: deleted.length });
});

// ── Dedupe existing rows (Clay-style "Dedupe by this column") ──────────────────

/**
 * Preview a dedupe of rows ALREADY in this table by one or more key columns.
 * `keys` is a comma-separated list of column keys. No mutation — returns the
 * number of duplicate clusters (`groups`) and the rows that WOULD be merged away
 * (`rows`). 404 if the table is unknown; empty/missing `keys` → groups/rows 0.
 */
tablesRoutes.get('/:id/duplicates', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  const keys = (c.req.query('keys') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const { groups, rows } = await dedupeExistingRows(tableId, keys, { dryRun: true });
  return c.json({ keys, groups, rows });
});

const dedupeRowsSchema = z.object({ keys: z.array(z.string().min(1)).min(1) });

/**
 * Dedupe rows ALREADY in this table by `keys`: in each cluster keep the oldest
 * row, fill its empty fields from the dupes (never clobbering), then delete the
 * dupes. Audited and idempotent (a second run merges 0). 400 on empty `keys`;
 * 404 if the table is unknown.
 */
tablesRoutes.post('/:id/dedupe', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof dedupeRowsSchema>;
  try {
    body = dedupeRowsSchema.parse(await c.req.json().catch(() => ({})));
  } catch {
    return c.json({ error: 'a non-empty `keys` array is required' }, 400);
  }

  const { groups, merged, kept } = await dedupeExistingRows(tableId, body.keys, { actor: 'user' });
  return c.json({ groups, merged, kept });
});

const runTableSchema = z.object({
  leadIds: z.array(z.string()).default([]),
  /** Run only the FIRST `limit` empty cells per dogi column — "Test N rows". */
  limit: z.number().int().nonnegative().optional(),
  /** Optional BYOK key for this run; passed to each job, never persisted. */
  apiKey: z.string().optional(),
});

/**
 * Run a table's RUNNABLE columns over a set of rows. For each selected lead ×
 * each `dogi` column whose cell is empty, enqueue one `enrich` job. Each
 * `formula` column is recomputed inline (cheap, no job). `manual` columns are
 * skipped. Run-only-if-empty governs the dogi enqueues. Leads not in this table
 * are ignored. Returns the count of enqueued jobs and recomputed formula cells.
 */
tablesRoutes.post('/:id/run', async (c) => {
  const tableId = c.req.param('id');
  const { leadIds, limit, apiKey } = runTableSchema.parse(await c.req.json().catch(() => ({})));

  const cols = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const targetLeads = leadIds.length
    ? await db.query.leads.findMany({
        where: and(eq(leads.tableId, tableId), inArray(leads.id, leadIds)),
      })
    : [];

  let enqueued = 0;
  let formula = 0;
  for (const column of cols) {
    if (column.type === 'dogi') {
      // run-only-if-empty; with a `limit`, only the first N empty cells fire.
      const empties = targetLeads.filter((lead) => isCellEmpty(lead, column.key));
      const toRun = limit != null ? empties.slice(0, limit) : empties;
      for (const lead of toRun) {
        await enqueue('enrich', { leadId: lead.id, columnKey: column.key, apiKey }, { leadId: lead.id });
        enqueued++;
      }
    } else if (column.type === 'formula') {
      formula += await runFormulaColumn(tableId, column.key, targetLeads.map((l) => l.id));
    }
    // manual columns are skipped.
  }
  return c.json({ enqueued, formula }, 202);
});

// ── Plan execution helpers (shared by apply-plan and doggo/run) ───────────────

type ColumnRow = typeof columnsTable.$inferSelect;

/**
 * Create ONE `dogi` column per column step (idempotent by key, audited), exactly
 * as apply-plan does. Reuses the caller's `byKey` map of already-present columns
 * so re-applying reuses instead of duplicating. Collects the keys of root steps
 * (`dependsOn` empty) so the caller can enqueue them. `brain` (when given) is
 * folded into each created column's config so Doggo's default brain drives runs.
 */
async function createPlanColumns(
  tableId: string,
  steps: DogiPlanStep[],
  byKey: Map<string, ColumnRow>,
  brain?: DogiBrain,
): Promise<{ created: ColumnRow[]; rootKeys: string[] }> {
  const created: ColumnRow[] = [];
  const rootKeys: string[] = [];

  for (const step of steps) {
    const key = (step.output?.key && step.output.key.trim()) || snakeCase(step.label);
    if (!key) continue;
    if (step.dependsOn.length === 0) rootKeys.push(key);

    // Idempotent: reuse an existing column with this key instead of re-creating.
    const present = byKey.get(key);
    if (present) {
      created.push(present);
      continue;
    }

    const config: Record<string, unknown> = {
      kind: 'dogi',
      instruction: step.instruction,
      reads: step.reads,
      output: { mode: 'create', key, label: step.output?.label ?? step.label },
      sources: step.sources,
      policy: step.policy,
      dependsOn: step.dependsOn,
    };
    // Doggo hands its default brain to the columns it builds (unless the step
    // already carries one). Lets a table's settings.doggo.brain drive runs.
    if (brain) config.brain = brain;

    try {
      const [col] = await db
        .insert(columnsTable)
        .values({ tableId, key, label: step.label, type: 'dogi', config })
        .returning();
      byKey.set(key, col!);
      created.push(col!);
      await audit({ entity: 'column', entityId: col!.id, action: 'create', diff: { key, plan: true } });
    } catch {
      // A name/key clash — skip; the column already exists under that label.
    }
  }

  return { created, rootKeys };
}

/**
 * Enqueue the ROOT columns (`dependsOn` empty) across ALL of the table's leads,
 * run-only-if-empty — exactly as apply-plan does. Dependent steps chain on in the
 * worker as their inputs fill. Returns the number of jobs enqueued.
 */
async function enqueueRootRuns(tableId: string, rootKeys: string[], apiKey?: string): Promise<number> {
  const tableLeads = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
  let enqueued = 0;
  for (const key of rootKeys) {
    for (const lead of tableLeads) {
      if (!isCellEmpty(lead, key)) continue;
      await enqueue('enrich', { leadId: lead.id, columnKey: key, apiKey }, { leadId: lead.id });
      enqueued++;
    }
  }
  return enqueued;
}

// ── Goal mode (Phase D): Ask Dogi → plan → apply ──────────────────────────────

const askDogiSchema = z.object({
  goal: z.string().min(1),
  /** Optional BYOK key for the planning call; never persisted or logged. */
  apiKey: z.string().optional(),
});

/**
 * Ask Dogi a GOAL; get back a structured PLAN (ordered cell-Dogis with deps),
 * never prose. The plan is reviewed/edited by a human before anything is built.
 * Returns `{ plan: null, reason }` when no LLM is configured (the planner needs
 * a brain). 404 for an unknown table, 400 for a missing goal.
 */
tablesRoutes.post('/:id/ask-dogi', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof askDogiSchema>;
  try {
    body = askDogiSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `goal` is required' }, 400);
  }

  if (!getLLM(body.apiKey ? { apiKey: body.apiKey } : {})) {
    return c.json({ plan: null, reason: 'no LLM configured' });
  }

  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const plan = await planGoal(body.goal, {
    existingColumns: existing.map((col) => col.key),
    apiKey: body.apiKey,
  });
  if (!plan) return c.json({ plan: null, reason: 'no LLM configured' });
  return c.json({ plan });
});

const planSourceSchema = z.union([
  z.object({ type: z.literal('provider'), name: z.string() }),
  z.object({ type: z.literal('web'), via: z.enum(['native', 'external']) }),
  z.object({ type: z.literal('scrape'), via: z.literal('firecrawl') }),
  z.object({ type: z.literal('llm') }),
]);

const planStepSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  instruction: z.string().min(1),
  reads: z.array(z.string()).default([]),
  output: z
    .object({
      mode: z.literal('create').default('create'),
      key: z.string().optional(),
      label: z.string().optional(),
    })
    .default({ mode: 'create' }),
  sources: z.array(planSourceSchema).default([{ type: 'llm' }]),
  policy: z.enum(['combine', 'first']).default('combine'),
  dependsOn: z.array(z.string()).default([]),
});

const applyPlanSchema = z.object({
  steps: z.array(planStepSchema).min(1),
  /** Optional BYOK key threaded to the kicked-off runs; never persisted. */
  apiKey: z.string().optional(),
});

/**
 * Apply an (approved, possibly edited) plan: create ONE `dogi` column per step,
 * audited, then KICK OFF execution by enqueuing runs for the ROOT steps
 * (`dependsOn` empty) across the table's leads (run-only-if-empty). Dependent
 * steps chain on automatically in the worker as their inputs fill.
 *
 * Idempotent on column creation: a step whose key already exists is reused, not
 * duplicated. Returns the created/reused columns.
 */
tablesRoutes.post('/:id/apply-plan', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof applyPlanSchema>;
  try {
    body = applyPlanSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `steps` array is required' }, 400);
  }

  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const byKey = new Map(existing.map((col) => [col.key, col]));

  const { created, rootKeys } = await createPlanColumns(
    tableId,
    body.steps as DogiPlanStep[],
    byKey,
  );

  // Kick off the root steps across the whole table (run-only-if-empty).
  const enqueued = await enqueueRootRuns(tableId, rootKeys, body.apiKey);

  return c.json({ columns: created, enqueued }, 201);
});

// ── Doggo (Phase I): autonomous orchestrator with row-sourcing ────────────────

const doggoPlanSchema = z.object({
  goal: z.string().min(1),
  /** Optional BYOK key for the planning call; never persisted or logged. */
  apiKey: z.string().optional(),
});

/** A row-sourcing plan step (creates rows). `kind` defaults to 'source-rows'. */
const sourceRowsStepSchema = z.object({
  kind: z.literal('source-rows').default('source-rows'),
  description: z.string().min(1),
  count: z.number().int().positive().default(10),
  primaryField: z.string().min(1).default('company'),
  primaryLabel: z.string().min(1).default('Company'),
});

/** A column plan step — today's step schema, tagged `kind: 'column'`. */
const columnPlanStepSchema = planStepSchema.extend({
  kind: z.literal('column').default('column'),
});

/** A Doggo plan step is EITHER a source-rows step or a column step. */
const doggoStepSchema = z.union([sourceRowsStepSchema, columnPlanStepSchema]);

const doggoRunSchema = z.object({
  plan: z.object({
    goal: z.string().optional(),
    steps: z.array(doggoStepSchema).min(1),
  }),
  /** Optional BYOK key threaded to created columns' runs; never persisted. */
  apiKey: z.string().optional(),
});

/**
 * Ask DOGGO a GOAL → a structured PLAN of ordered steps (row-sourcing +
 * columns), never prose. NO MUTATION — this only proposes; the human approves
 * before `/doggo/run` executes. Reuses the planner with table context (existing
 * columns + current row count, so an empty table favors a leading source-rows
 * step). Returns `{ plan: null, reason }` when no LLM is configured. 404 unknown
 * table, 400 missing goal.
 */
tablesRoutes.post('/:id/doggo/plan', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof doggoPlanSchema>;
  try {
    body = doggoPlanSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `goal` is required' }, 400);
  }

  const doggoSettings = (table.settings as { doggo?: { brain?: DogiBrain } } | null)?.doggo;
  if (!getLLM(body.apiKey ? { apiKey: body.apiKey } : doggoSettings?.brain ?? {})) {
    return c.json({ plan: null, reason: 'no LLM configured' });
  }

  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const [rowCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(eq(leads.tableId, tableId));

  const plan = await planDoggo(body.goal, {
    existingColumns: existing.map((col) => col.key),
    rowCount: rowCountRow?.n ?? 0,
    brain: doggoSettings?.brain,
    apiKey: body.apiKey,
  });
  if (!plan) return c.json({ plan: null, reason: 'no LLM configured' });
  return c.json({ plan });
});

/**
 * Run an (approved) Doggo plan. Order of operations (devx/doggo.md §5):
 *  1. SOURCE ROWS — for each source-rows step, generate entities (`sourceRows`)
 *     and insert them as leads (`insertSourcedRows`, which reuses `ingestLead` so
 *     the table's dedupe policy applies — re-running won't duplicate).
 *  2. CREATE COLUMNS — create one `dogi` column per column step, REUSING the
 *     exact apply-plan logic (idempotent by key, audited). Doggo's default brain
 *     (from `settings.doggo`) is handed to the columns it builds.
 *  3. ENQUEUE — kick off the ROOT columns across ALL the table's leads (incl. the
 *     newly sourced ones), run-only-if-empty; dependents chain in the worker.
 *
 * Returns `{ rowsCreated, columnsCreated, enqueued }`. 404 unknown table, 400 on
 * an empty/invalid plan.
 */
tablesRoutes.post('/:id/doggo/run', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof doggoRunSchema>;
  try {
    body = doggoRunSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `plan.steps` array is required' }, 400);
  }

  // Doggo settings (light): table.settings.doggo overrides the brain / default
  // Dogi config it gives created columns; else the env default provider/model.
  const doggoSettings =
    (table.settings as { doggo?: { brain?: DogiBrain } } | null)?.doggo ?? undefined;
  const brain = doggoSettings?.brain;

  const steps = body.plan.steps as DoggoPlanStep[];
  const sourceSteps = steps.filter((s): s is SourceRowsStep => isSourceRowsStep(s));
  const columnSteps = steps.filter((s) => !isSourceRowsStep(s)) as DogiPlanStep[];

  // Existing columns up front, so the primary-field column we materialize is
  // idempotent (skip if present) and can be positioned left of enrichment ones.
  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const byKey = new Map(existing.map((col) => [col.key, col]));

  // 1) Source rows first, so columns enqueue over the newly created leads too.
  //    Each source-rows step also MATERIALIZES a manual column for its
  //    primaryField, so the sourced values (written into lead.data) are visible
  //    in the grid — left of the enrichment columns (R1.1).
  let rowsCreated = 0;
  let primaryColsCreated = 0;
  for (const step of sourceSteps) {
    const { rows } = await sourceRows({
      description: step.description,
      count: step.count,
      fields: [step.primaryField],
      brain,
      apiKey: body.apiKey,
    });
    if (rows.length === 0) continue;

    // Materialize the primary column (idempotent by key). Negative position keeps
    // it left of the enrichment columns, which createPlanColumns inserts after.
    if (!byKey.get(step.primaryField)) {
      try {
        const [col] = await db
          .insert(columnsTable)
          .values({
            tableId,
            key: step.primaryField,
            label: step.primaryLabel,
            type: 'manual',
            config: {},
            position: -1 - primaryColsCreated,
          })
          .returning();
        byKey.set(step.primaryField, col!);
        primaryColsCreated++;
        await audit({
          entity: 'column',
          entityId: col!.id,
          action: 'create',
          actor: 'doggo',
          diff: { key: step.primaryField, sourcedPrimary: true },
        });
      } catch {
        // A clash on key/label — the column already exists; reuse it.
      }
    }

    const [source] = await db
      .insert(sources)
      .values({ type: 'manual', raw: { doggo: step.description, count: step.count } })
      .returning();
    const { created } = await insertSourcedRows(rows, {
      tableId,
      sourceId: source!.id,
      actor: 'doggo',
    });
    rowsCreated += created;
  }

  // 2) Create columns, reusing apply-plan's idempotent/audited logic.
  const before = byKey.size;
  const { rootKeys } = await createPlanColumns(tableId, columnSteps, byKey, brain);
  const columnsCreated = byKey.size - before;

  // 3) Enqueue the root columns across ALL leads (incl. newly sourced).
  const enqueued = await enqueueRootRuns(tableId, rootKeys, body.apiKey);

  await audit({
    entity: 'table',
    entityId: tableId,
    action: 'update',
    actor: 'doggo',
    diff: { doggo: { goal: body.plan.goal ?? null, rowsCreated, columnsCreated, enqueued } },
  });

  return c.json({ rowsCreated, columnsCreated, enqueued });
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
  /** Run only the FIRST `limit` of the to-run leads — the "Test 5 rows" path. */
  limit: z.number().int().nonnegative().optional(),
  /** Optional BYOK key for this run; passed to the job, never persisted. */
  apiKey: z.string().optional(),
});

tablesRoutes.post('/:id/columns/:key/run', async (c) => {
  const tableId = c.req.param('id');
  const key = c.req.param('key');
  const { leadIds, force, limit, apiKey } = runSchema.parse(await c.req.json().catch(() => ({})));

  const plan = await planRun(tableId, key, leadIds, { force, limit });
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
