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
import { clearCells, getColumn, isCellEmpty, planRun, runFormulaColumn } from '@fetch/columns';
import {
  isSourceRowsStep,
  planBone,
  planGoal,
  sourceRows,
  type DogiBrain,
  type DogiPlanStep,
  type BonePlanStep,
  type SourceRowsStep,
} from '@fetch/agent';
import { getLLM } from '@fetch/llm';
import {
  identityFieldFor,
  parseCsvRecords,
  previewCsv,
  recordToCanonicalWithMapping,
  snakeCase,
} from '@fetch/connectors';
import type { ImportMapping } from '@fetch/connectors';
import type { CanonicalLead } from '@fetch/core';
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
 * `settings.dedupe`, the per-table dedupe policy — Phase G;
 * `settings.agentColumn`, the flow agent-column toggle — Round 9).
 *
 * `settings` is **shallow-merged** into the stored object (not replaced), so a
 * caller patching one key (e.g. `{ agentColumn: true }`) never clobbers
 * sibling keys like `settings.flows`/`settings.bone`/`settings.dedupe` that
 * other flows persist. Pass `{ <key>: null }` to drop a key.
 */
const patchSchema = createSchema.partial().extend({
  settings: z.record(z.unknown()).optional(),
});

tablesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const { settings, ...rest } = patchSchema.parse(await c.req.json());

  const existing = await db.query.tables.findFirst({ where: eq(tables.id, id) });
  if (!existing) return c.json({ error: 'not found' }, 404);

  const merged =
    settings !== undefined
      ? { ...((existing.settings as Record<string, unknown> | null) ?? {}), ...settings }
      : undefined;

  const [updated] = await db
    .update(tables)
    .set({ ...rest, ...(merged !== undefined ? { settings: merged } : {}) })
    .where(eq(tables.id, id))
    .returning();
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

/**
 * Quick-add accepts an ARBITRARY object — a Fetch table is arbitrary columns, so
 * every provided key must survive into `leads.data` (Clay/Airtable-style). We
 * validate `email` as an email when present, but otherwise passthrough so a typed
 * `{ company, outreach_angle, … }` is never silently dropped. An empty body still
 * creates a blank "+ new lead" row.
 */
const manualLeadSchema = z.object({ email: z.string().email().optional() }).passthrough();

/**
 * Build a CanonicalLead from a quick-add body. EVERY key lands in `data` verbatim
 * (so it's visible as a grid cell), and recognized identity keys are ALSO mirrored
 * to the canonical lead columns so sending/dedupe keep working. A recognized key
 * can live in both `data` and its canonical slot. Mirrors `sourcedRowToCanonical`.
 */
function quickAddToCanonical(body: Record<string, unknown>): CanonicalLead {
  const data: Record<string, unknown> = {};
  // Preserve every provided key (skipping blanks) into data verbatim.
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    data[k] = typeof v === 'string' ? v.trim() : v;
  }

  const canonical: CanonicalLead = { data };
  const str = (k: string): string | undefined => {
    const v = data[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  // Mirror recognized identity keys to canonical columns (accepting both camel and
  // snake aliases). The values STAY in `data` too, so they remain visible cells.
  const email = str('email');
  if (email) canonical.email = email.toLowerCase();

  const first = str('firstName') ?? str('first_name');
  const last = str('lastName') ?? str('last_name');
  const name = str('name') ?? str('full_name');
  if (first || last) {
    if (first) canonical.firstName = first;
    if (last) canonical.lastName = last;
  } else if (name) {
    const [f, ...rest] = name.split(/\s+/);
    canonical.firstName = f ?? null;
    canonical.lastName = rest.length ? rest.join(' ') : null;
  }

  const phone = str('phone');
  if (phone) canonical.phone = phone;
  const title = str('title');
  if (title) canonical.title = title;
  const linkedin = str('linkedinUrl') ?? str('linkedin_url') ?? str('linkedin');
  if (linkedin) canonical.linkedinUrl = linkedin;

  return canonical;
}

/** Create one blank/manual lead in a table (the grid's "+ new lead"). */
tablesRoutes.post('/:id/leads', async (c) => {
  const tableId = c.req.param('id');
  const body = manualLeadSchema.parse(await c.req.json().catch(() => ({})));
  const [source] = await db.insert(sources).values({ type: 'manual', raw: body }).returning();

  const canonical = quickAddToCanonical(body as Record<string, unknown>);

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

// ── Plan execution helpers (shared by apply-plan and bone/run) ───────────────

type ColumnRow = typeof columnsTable.$inferSelect;

/** A short, URL-safe id for a persisted flow (e.g. `flow_a1b2c3d4`). */
function shortFlowId(): string {
  return `flow_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Create ONE `dogi` column per column step (idempotent by key, audited), exactly
 * as apply-plan does. Reuses the caller's `byKey` map of already-present columns
 * so re-applying reuses instead of duplicating. Collects the keys of root steps
 * (`dependsOn` empty) so the caller can enqueue them. `brain` (when given) is
 * folded into each created column's config so Bone's default brain drives runs.
 *
 * `flowId` (optional, default-off) tags each NEWLY created column with
 * `config.flowId` so a Bone run's columns can be re-run as a unit. apply-plan /
 * ask-dogi pass nothing, so their columns are NEVER flow-tagged.
 */
async function createPlanColumns(
  tableId: string,
  steps: DogiPlanStep[],
  byKey: Map<string, ColumnRow>,
  brain?: DogiBrain,
  flowId?: string,
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
    // Bone hands its default brain to the columns it builds (unless the step
    // already carries one). Lets a table's settings.bone.brain drive runs.
    if (brain) config.brain = brain;
    // Tag the column with the flow that built it (Bone runs only).
    if (flowId) config.flowId = flowId;

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

/**
 * The table's existing values for `field`, read from `leads.data[field]`,
 * lowercased + trimmed (blanks dropped). Used to tell `sourceRows` which
 * primary values already exist so a re-source generates only NEW entities, and
 * to drop returned rows that already exist (append-dedupe, known-issue #4).
 */
async function existingPrimaryValues(tableId: string, field: string): Promise<Set<string>> {
  const rows = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
  const out = new Set<string>();
  for (const lead of rows) {
    const v = (lead.data as Record<string, unknown> | null)?.[field];
    if (v == null) continue;
    const s = String(v).trim().toLowerCase();
    if (s !== '') out.add(s);
  }
  return out;
}

/**
 * Source NEW deduped rows for one source-rows step and insert them. BEFORE
 * sourcing, the table's existing primaryField values are passed as `exclude` so
 * the model skips them; AFTER sourcing, any returned row whose primaryField
 * value already exists is dropped (belt-and-suspenders, case-insensitive).
 * Only the genuinely-new rows are inserted; if none are new, nothing is inserted
 * (and 0 is returned). Returns the ACTUAL count of leads created.
 */
async function sourceDedupedRows(
  tableId: string,
  step: { description: string; count: number; primaryField: string },
  count: number,
  brain?: DogiBrain,
  apiKey?: string,
): Promise<number> {
  const existing = await existingPrimaryValues(tableId, step.primaryField);
  const { rows } = await sourceRows({
    description: step.description,
    count,
    fields: [step.primaryField],
    brain,
    apiKey,
    exclude: [...existing],
  });
  // Belt-and-suspenders: drop anything that already exists despite the prompt.
  const fresh = rows.filter(
    (r) => !existing.has(String(r[step.primaryField] ?? '').trim().toLowerCase()),
  );
  if (fresh.length === 0) return 0;

  const [source] = await db
    .insert(sources)
    .values({ type: 'manual', raw: { source: step.description, count } })
    .returning();
  const { created } = await insertSourcedRows(fresh, { tableId, sourceId: source!.id, actor: 'bone' });
  return created;
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

// ── Bone (Phase I): autonomous orchestrator with row-sourcing ────────────────

const bonePlanSchema = z.object({
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

/** A Bone plan step is EITHER a source-rows step or a column step. */
const boneStepSchema = z.union([sourceRowsStepSchema, columnPlanStepSchema]);

const boneRunSchema = z.object({
  plan: z.object({
    goal: z.string().optional(),
    steps: z.array(boneStepSchema).min(1),
  }),
  /** Optional BYOK key threaded to created columns' runs; never persisted. */
  apiKey: z.string().optional(),
  /**
   * Build-and-run (default) vs Build only. When `false`, create the rows +
   * columns exactly as usual but SKIP enqueuing any runs (response
   * `enqueued: 0`). Lets the UI offer a "Build only" opt-out (known-issue #5).
   */
  run: z.boolean().default(true),
});

/**
 * Ask BONE a GOAL → a structured PLAN of ordered steps (row-sourcing +
 * columns), never prose. NO MUTATION — this only proposes; the human approves
 * before `/bone/run` executes. Reuses the planner with table context (existing
 * columns + current row count, so an empty table favors a leading source-rows
 * step). Returns `{ plan: null, reason }` when no LLM is configured. 404 unknown
 * table, 400 missing goal.
 */
tablesRoutes.post('/:id/bone/plan', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof bonePlanSchema>;
  try {
    body = bonePlanSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `goal` is required' }, 400);
  }

  const boneSettings = (table.settings as { bone?: { brain?: DogiBrain } } | null)?.bone;
  if (!getLLM(body.apiKey ? { apiKey: body.apiKey } : boneSettings?.brain ?? {})) {
    return c.json({ plan: null, reason: 'no LLM configured' });
  }

  const existing = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const [rowCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(eq(leads.tableId, tableId));

  const plan = await planBone(body.goal, {
    existingColumns: existing.map((col) => col.key),
    rowCount: rowCountRow?.n ?? 0,
    brain: boneSettings?.brain,
    apiKey: body.apiKey,
  });
  if (!plan) return c.json({ plan: null, reason: 'no LLM configured' });
  return c.json({ plan });
});

/**
 * Run an (approved) Bone plan. Order of operations (devx/bone.md §5):
 *  1. SOURCE ROWS — for each source-rows step, generate entities (`sourceRows`)
 *     and insert them as leads (`insertSourcedRows`, which reuses `ingestLead` so
 *     the table's dedupe policy applies — re-running won't duplicate).
 *  2. CREATE COLUMNS — create one `dogi` column per column step, REUSING the
 *     exact apply-plan logic (idempotent by key, audited). Bone's default brain
 *     (from `settings.bone`) is handed to the columns it builds.
 *  3. ENQUEUE — kick off the ROOT columns across ALL the table's leads (incl. the
 *     newly sourced ones), run-only-if-empty; dependents chain in the worker.
 *  4. PERSIST — append a re-runnable flow entry to `table.settings.flows` (the
 *     goal, the steps, every column key it created/targeted, the source-rows
 *     steps) and tag each created column with `config.flowId`, so the whole flow
 *     can be re-run via `POST /tables/:id/flow/:flowId/run` (Round 9).
 *
 * Returns `{ rowsCreated, columnsCreated, enqueued, flowId }`. 404 unknown table,
 * 400 on an empty/invalid plan.
 */
tablesRoutes.post('/:id/bone/run', async (c) => {
  const tableId = c.req.param('id');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  let body: z.infer<typeof boneRunSchema>;
  try {
    body = boneRunSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'a non-empty `plan.steps` array is required' }, 400);
  }

  // Bone settings (light): table.settings.bone overrides the brain / default
  // Dogi config it gives created columns; else the env default provider/model.
  const boneSettings =
    (table.settings as { bone?: { brain?: DogiBrain } } | null)?.bone ?? undefined;
  const brain = boneSettings?.brain;

  const steps = body.plan.steps as BonePlanStep[];
  const sourceSteps = steps.filter((s): s is SourceRowsStep => isSourceRowsStep(s));
  const columnSteps = steps.filter((s) => !isSourceRowsStep(s)) as DogiPlanStep[];

  // This run's flow id — every column it creates/targets gets tagged with it, and
  // it's persisted to settings.flows so the flow can be re-run as a unit.
  const flowId = shortFlowId();
  // Every column key this run created OR targeted (sourced primary fields +
  // dogi column outputs), so the flow knows which columns to re-fill.
  const flowColumnKeys = new Set<string>();

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
    // Source NEW deduped rows (excludes existing primary values + drops dupes).
    // A fresh table has nothing to exclude, so this is the normal initial source.
    const existing = await existingPrimaryValues(tableId, step.primaryField);
    const { rows: sourced } = await sourceRows({
      description: step.description,
      count: step.count,
      fields: [step.primaryField],
      brain,
      apiKey: body.apiKey,
      exclude: [...existing],
    });
    const rows = sourced.filter(
      (r) => !existing.has(String(r[step.primaryField] ?? '').trim().toLowerCase()),
    );
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
            // Bone-created (manual) column — provenance so the grid can show
            // "by Bone" (a dogi column self-identifies by type:'dogi'); the
            // flowId ties it to this re-runnable flow.
            config: { createdBy: 'bone', flowId },
            position: -1 - primaryColsCreated,
          })
          .returning();
        byKey.set(step.primaryField, col!);
        primaryColsCreated++;
        await audit({
          entity: 'column',
          entityId: col!.id,
          action: 'create',
          actor: 'bone',
          diff: { key: step.primaryField, sourcedPrimary: true, flowId },
        });
      } catch {
        // A clash on key/label — the column already exists; reuse it.
      }
    }
    flowColumnKeys.add(step.primaryField);

    const [source] = await db
      .insert(sources)
      .values({ type: 'manual', raw: { bone: step.description, count: step.count } })
      .returning();
    const { created } = await insertSourcedRows(rows, {
      tableId,
      sourceId: source!.id,
      actor: 'bone',
    });
    rowsCreated += created;
  }

  // 2) Create columns, reusing apply-plan's idempotent/audited logic. Tag them
  //    with this flow id so the flow can re-fill them later.
  const before = byKey.size;
  const { rootKeys } = await createPlanColumns(tableId, columnSteps, byKey, brain, flowId);
  const columnsCreated = byKey.size - before;
  for (const step of columnSteps) {
    const key = (step.output?.key && step.output.key.trim()) || snakeCase(step.label);
    if (key) flowColumnKeys.add(key);
  }

  // 3) Enqueue the root columns across ALL leads (incl. newly sourced) — unless
  //    this is a Build-only run (`run:false`), in which case we enqueue nothing.
  const enqueued = body.run ? await enqueueRootRuns(tableId, rootKeys, body.apiKey) : 0;

  // 4) Persist the flow so it can be re-run as a unit. Read-modify-write
  //    settings.flows (like settings.bone), never clobbering sibling settings.
  const goal = body.plan.goal ?? null;
  const name = (goal ?? `Flow ${flowId}`).trim().slice(0, 60);
  const flowEntry = {
    id: flowId,
    name,
    goal,
    steps,
    columnKeys: [...flowColumnKeys],
    sourceSteps,
    createdAt: new Date().toISOString(),
  };
  const fresh = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  const prevSettings = (fresh?.settings as Record<string, unknown> | null) ?? {};
  const prevFlows = Array.isArray(prevSettings.flows) ? prevSettings.flows : [];
  await db
    .update(tables)
    .set({ settings: { ...prevSettings, flows: [...prevFlows, flowEntry] } })
    .where(eq(tables.id, tableId));

  await audit({
    entity: 'table',
    entityId: tableId,
    action: 'update',
    actor: 'bone',
    diff: { bone: { goal, rowsCreated, columnsCreated, enqueued, flowId } },
  });

  return c.json({ rowsCreated, columnsCreated, enqueued, flowId });
});

// ── Run a persisted flow as a unit (Round 9) ──────────────────────────────────

type FlowEntry = {
  id: string;
  name: string;
  goal: string | null;
  steps: BonePlanStep[];
  columnKeys: string[];
  sourceSteps: SourceRowsStep[];
  createdAt: string;
};

const flowRunSchema = z.object({
  /**
   * Re-run mode (known-issue #6). Defaults to `retry` for back-compat with the
   * old `{ sourceMore?, force? }` body:
   *  - `replace` — CLEAR the flow's column cells for ALL leads, then re-enqueue
   *    so they re-run & overwrite.
   *  - `retry`   — enqueue run-only-if-empty (failed/empty cells re-run, filled
   *    cells skipped).
   *  - `addNew`  — source `sourceMore` NEW deduped rows and enqueue the flow's
   *    columns ONLY for those new lead ids (existing cells untouched).
   */
  mode: z.enum(['replace', 'retry', 'addNew']).default('retry'),
  /** Source ~this many NEW deduped rows first (clamped 1–50). */
  sourceMore: z.number().int().positive().optional(),
  /** Optional BYOK key threaded to the runs; never persisted. */
  apiKey: z.string().optional(),
});

/**
 * Source `sourceMore` NEW deduped rows for a flow's source steps, returning the
 * total created AND the ids of the leads created in this call (so `addNew` can
 * scope its enqueue to only the new rows). Splits the requested count across the
 * flow's source steps and clamps the total to 1–50.
 */
async function sourceMoreForFlow(
  tableId: string,
  flow: FlowEntry,
  sourceMore: number,
  brain?: DogiBrain,
  apiKey?: string,
): Promise<{ rowsCreated: number; newLeadIds: string[] }> {
  if (!(sourceMore > 0) || flow.sourceSteps.length === 0) {
    return { rowsCreated: 0, newLeadIds: [] };
  }
  // Snapshot the lead ids present BEFORE sourcing so we can diff out the new ones.
  const before = new Set(
    (await db.query.leads.findMany({ where: eq(leads.tableId, tableId) })).map((l) => l.id),
  );

  const total = Math.max(1, Math.min(50, sourceMore));
  const per = Math.max(1, Math.ceil(total / flow.sourceSteps.length));
  let rowsCreated = 0;
  for (const step of flow.sourceSteps) {
    rowsCreated += await sourceDedupedRows(tableId, step, per, brain, apiKey);
  }

  const after = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
  const newLeadIds = after.filter((l) => !before.has(l.id)).map((l) => l.id);
  return { rowsCreated, newLeadIds };
}

/**
 * Enqueue a flow's runnable (dogi) ROOT columns over a specific set of lead ids,
 * run-only-if-empty. `addNew` scopes this to only the newly-created leads;
 * `replace`/`retry` pass all the table's lead ids. Dependents chain in the
 * worker. Returns the number of jobs enqueued.
 */
async function enqueueFlowRoots(
  rootKeys: string[],
  leadRows: Array<typeof leads.$inferSelect>,
  apiKey?: string,
): Promise<number> {
  let enqueued = 0;
  for (const key of rootKeys) {
    for (const lead of leadRows) {
      if (!isCellEmpty(lead, key)) continue;
      await enqueue('enrich', { leadId: lead.id, columnKey: key, apiKey }, { leadId: lead.id });
      enqueued++;
    }
  }
  return enqueued;
}

/**
 * Re-run a persisted Bone flow as a unit (Round 9; modes from known-issue #6).
 * Looks the flow up in `table.settings.flows` (404 if the table or flow is
 * unknown), then runs one of three modes:
 *
 *  - `replace` — CLEAR the flow's column cells for ALL leads, then enqueue the
 *    flow's root columns so they re-run & overwrite. Honors `sourceMore`.
 *  - `retry`   — enqueue the flow's root columns run-only-if-empty (failed/empty
 *    cells re-run, filled cells skipped). Honors `sourceMore`.
 *  - `addNew`  — source `sourceMore` NEW deduped rows and enqueue the flow's
 *    columns ONLY for those new lead ids (existing cells untouched). If 0 new
 *    rows, enqueue nothing.
 *
 * All sourcing goes through the append-dedupe helper (excludes existing primary
 * values + drops dupes), so re-sourcing the same list never duplicates.
 *
 * Returns `{ rowsCreated, columnsRun, enqueued }`. Audited with the flow id.
 */
tablesRoutes.post('/:id/flow/:flowId/run', async (c) => {
  const tableId = c.req.param('id');
  const flowId = c.req.param('flowId');
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  if (!table) return c.json({ error: 'not found' }, 404);

  const flows = ((table.settings as { flows?: FlowEntry[] } | null)?.flows ?? []) as FlowEntry[];
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) return c.json({ error: 'unknown flow' }, 404);

  const body = flowRunSchema.parse(await c.req.json().catch(() => ({})));

  const boneSettings = (table.settings as { bone?: { brain?: DogiBrain } } | null)?.bone ?? undefined;
  const brain = boneSettings?.brain;

  // Resolve the flow's RUNNABLE (dogi) columns + its ROOT keys (no flow-internal
  // dependency). The worker chains dependents per lead as each input fills.
  const cols = await db.query.columns.findMany({ where: eq(columnsTable.tableId, tableId) });
  const flowKeySet = new Set(flow.columnKeys);
  const runnable = cols.filter((col) => flowKeySet.has(col.key) && col.type === 'dogi');
  const rootKeys = runnable
    .filter((col) => {
      const deps = ((col.config as { dependsOn?: string[] } | null)?.dependsOn ?? []).filter((d) =>
        flowKeySet.has(d),
      );
      return deps.length === 0;
    })
    .map((col) => col.key);

  let rowsCreated = 0;
  let enqueued = 0;

  if (body.mode === 'addNew') {
    // Source NEW deduped rows; enqueue the flow's roots ONLY over those new leads.
    const { rowsCreated: rc, newLeadIds } = await sourceMoreForFlow(
      tableId,
      flow,
      body.sourceMore ?? 0,
      brain,
      body.apiKey,
    );
    rowsCreated = rc;
    if (newLeadIds.length > 0) {
      const newLeads = await db.query.leads.findMany({
        where: and(eq(leads.tableId, tableId), inArray(leads.id, newLeadIds)),
      });
      enqueued = await enqueueFlowRoots(rootKeys, newLeads, body.apiKey);
    }
  } else {
    // replace / retry — optionally source more deduped rows first, then enqueue
    // over ALL of the table's leads.
    if (body.sourceMore && body.sourceMore > 0) {
      const { rowsCreated: rc } = await sourceMoreForFlow(
        tableId,
        flow,
        body.sourceMore,
        brain,
        body.apiKey,
      );
      rowsCreated = rc;
    }

    // `replace` clears the flow's column cells for ALL leads so they overwrite;
    // `retry` leaves filled cells untouched (run-only-if-empty).
    const allLeads = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
    if (body.mode === 'replace') {
      const leadIds = allLeads.map((l) => l.id);
      for (const col of runnable) await clearCells(leadIds, col.key);
    }

    // Re-read after clearing so isCellEmpty reflects the cleared cells.
    const leadsForRun =
      body.mode === 'replace'
        ? await db.query.leads.findMany({ where: eq(leads.tableId, tableId) })
        : allLeads;
    enqueued = await enqueueFlowRoots(rootKeys, leadsForRun, body.apiKey);
  }

  await audit({
    entity: 'table',
    entityId: tableId,
    action: 'flow_run',
    actor: 'bone',
    diff: { flowId, mode: body.mode, rowsCreated, columnsRun: runnable.length, enqueued },
  });

  return c.json({ rowsCreated, columnsRun: runnable.length, enqueued });
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
