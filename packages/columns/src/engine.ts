import { columns as columnsTable, db, leads } from '@fetch/db';
import type { Column, Lead } from '@fetch/db';
import { audit } from '@fetch/core';
import { and, eq, inArray } from 'drizzle-orm';
import { cellStatusOf, isCellEmpty, writeCell, writeCellFailure } from './cell';
import { outputKeyOf, resolveCell, type ResolveContext } from './resolve';

/**
 * The run-column engine. "Running a column" = firing its job across rows.
 *
 * Columns are scoped to a table (Phase A), so a column is looked up by
 * `(tableId, key)`. Two kinds resolve WITHOUT a background job:
 *   - formula → derived locally, recomputed inline
 *   - manual  → a human types it, never auto-run
 * `dogi` columns are slow/network and resolve in a worker, so the API enqueues
 * one job per row. `planRun` decides which leads need a job (run-only-if-empty).
 */

/** Look up a column within a table by its key. */
export async function getColumn(tableId: string, key: string): Promise<Column | undefined> {
  return db.query.columns.findFirst({
    where: and(eq(columnsTable.tableId, tableId), eq(columnsTable.key, key)),
  });
}

/** Look up a column by its id (unique across tables). */
export async function getColumnById(id: string): Promise<Column | undefined> {
  return db.query.columns.findFirst({ where: eq(columnsTable.id, id) });
}

export interface RunPlan {
  column: Column;
  /** Leads whose cell is empty and therefore need resolving. */
  toRun: Lead[];
  /** Leads skipped because the cell already has a value (run-only-if-empty). */
  skipped: number;
}

/**
 * Decide what a run touches within a table. `force` ignores run-only-if-empty
 * (a deliberate re-run). With no explicit leadIds it scans the whole table.
 * `limit` runs only the FIRST N of the to-run leads — the "Test 5 rows" path —
 * so a sample fires before committing to the full table. Leads dropped by the
 * limit are NOT counted as skipped (they're deferred, not already filled).
 */
export async function planRun(
  tableId: string,
  columnKey: string,
  leadIds: string[],
  opts: { force?: boolean; limit?: number } = {},
): Promise<RunPlan | null> {
  const column = await getColumn(tableId, columnKey);
  if (!column) return null;

  const rows = leadIds.length
    ? await db.query.leads.findMany({ where: inArray(leads.id, leadIds) })
    : await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });

  const eligible = opts.force ? rows : rows.filter((l) => isCellEmpty(l, columnKey));
  const skipped = rows.length - eligible.length;
  const toRun =
    opts.limit != null && opts.limit >= 0 ? eligible.slice(0, opts.limit) : eligible;
  return { column, toRun, skipped };
}

/**
 * Resolve and persist a single cell for one lead — the unit a worker runs for
 * `dogi` columns, and what `runFormulaColumn` calls inline. Derives the table
 * from the lead, so callers only need (leadId, columnKey). Returns whether a
 * value was written.
 *
 * Failures are first-class for `dogi` columns: a miss (resolveCell returns no
 * value) or a thrown error records `enrichmentConf[outputKey] = { status:
 * 'failed', error, at }` with NO value in `data` (so the cell stays empty and
 * re-runs naturally), and writes an `enrich_failed` audit row so the miss shows
 * up in /activity. A thrown error is recorded then re-thrown, so the queue still
 * sees the job as failed (retry/visibility) while the cell carries a reason.
 */
export async function runCell(
  leadId: string,
  columnKey: string,
  ctx?: ResolveContext,
): Promise<boolean> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return false;
  const column = await getColumn(lead.tableId, columnKey);
  if (!column) return false;

  const outKey = outputKeyOf(column);

  let resolved;
  try {
    resolved = await resolveCell(lead, column, ctx);
  } catch (err) {
    // Only dogi cells carry per-cell failure state; other types just propagate.
    if (column.type === 'dogi') {
      const message = err instanceof Error ? err.message : String(err);
      await recordCellFailure(leadId, outKey, message);
    }
    throw err;
  }

  if (!resolved) {
    if (column.type === 'dogi') {
      await recordCellFailure(leadId, outKey, 'No value found');
    }
    return false;
  }

  // A Dogi whose output is mapped/created writes to that key; default = its own.
  await writeCell(leadId, outKey, resolved);
  return true;
}

/**
 * Persist a per-cell failure marker AND an audit row for one dogi cell miss. No
 * value is written to `data`, so the cell stays empty (re-runnable).
 */
async function recordCellFailure(leadId: string, columnKey: string, error: string): Promise<void> {
  await writeCellFailure(leadId, columnKey, error);
  await audit({
    entity: 'lead',
    entityId: leadId,
    action: 'enrich_failed',
    actor: 'system',
    diff: { field: columnKey, error },
  });
}

/**
 * Goal-mode chaining (Phase D). After a dogi cell is filled for a lead, find the
 * dogi columns in the SAME table whose `config.dependsOn` includes `filledKey`,
 * whose EVERY dependency cell is now non-empty for this lead, and whose OWN
 * output cell is still empty. Those are the steps that just became runnable for
 * this lead — return their output keys so the caller can enqueue them.
 *
 * Idempotent by construction: a dependent whose cell is already filled (or whose
 * other deps aren't ready) is never returned, so a re-run enqueues nothing.
 */
export async function findReadyDependents(leadId: string, filledKey: string): Promise<string[]> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return [];

  const cols = await db.query.columns.findMany({
    where: and(eq(columnsTable.tableId, lead.tableId), eq(columnsTable.type, 'dogi')),
  });

  const ready: string[] = [];
  for (const col of cols) {
    const config = (col.config as Record<string, unknown>) ?? {};
    const dependsOn = Array.isArray(config.dependsOn)
      ? (config.dependsOn as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    if (!dependsOn.includes(filledKey)) continue; // not triggered by this fill

    const outKey = outputKeyOf(col);
    if (!isCellEmpty(lead, outKey)) continue; // already filled → idempotent skip

    // Every dependency must be non-empty for this lead before the step can run.
    if (!dependsOn.every((dep) => !isCellEmpty(lead, dep))) continue;

    ready.push(outKey);
  }
  return ready;
}

/** The dogi columns defined for a lead's table (output key + the column). */
export async function dogiColumnsForLead(leadId: string): Promise<{ column: Column; outputKey: string }[]> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return [];
  const cols = await db.query.columns.findMany({
    where: and(eq(columnsTable.tableId, lead.tableId), eq(columnsTable.type, 'dogi')),
  });
  return cols.map((column) => ({ column, outputKey: outputKeyOf(column) }));
}

/**
 * Derive a lead's per-LEAD enrichment status from its per-CELL state — replacing
 * the old last-writer-wins single field. We look only at the lead's dogi cells:
 *
 *   - 'failed'  → at least one dogi cell is failed AND none are still pending
 *                 (a partial fill with another column still failing is a failure
 *                 the user should see).
 *   - 'done'    → there are attempted dogi cells and every one of them is filled.
 *   - 'running' → some dogi cell is still pending/in-flight.
 *   - null      → no dogi cells attempted yet; leave the status untouched.
 *
 * `pending` here means a dogi column exists whose cell is neither filled nor
 * failed (never run / mid-run). Callers treating "running" should not overwrite a
 * status they don't have a clear value for — hence the null return.
 */
export async function deriveLeadEnrichmentStatus(
  leadId: string,
): Promise<'done' | 'failed' | 'running' | null> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return null;

  const dogiCols = await dogiColumnsForLead(leadId);
  if (dogiCols.length === 0) return null; // nothing dogi-driven on this lead

  let anyFailed = false;
  let anyPending = false;
  let anyAttempted = false;
  let allFilled = true;

  for (const { outputKey } of dogiCols) {
    const status = cellStatusOf(lead, outputKey);
    if (status === null) {
      // Never run → still pending work for this lead.
      anyPending = true;
      allFilled = false;
      continue;
    }
    anyAttempted = true;
    if (status === 'failed') {
      anyFailed = true;
      allFilled = false;
    } else if (status === 'filled') {
      // counts toward allFilled
    } else {
      anyPending = true;
      allFilled = false;
    }
  }

  if (anyFailed && !anyPending) return 'failed';
  if (anyAttempted && allFilled) return 'done';
  return 'running';
}

/** Recompute a formula column inline for a set of leads (no jobs needed). */
export async function runFormulaColumn(
  tableId: string,
  columnKey: string,
  leadIds: string[],
): Promise<number> {
  const plan = await planRun(tableId, columnKey, leadIds, { force: true });
  if (!plan || plan.column.type !== 'formula') return 0;
  let n = 0;
  for (const lead of plan.toRun) {
    const resolved = await resolveCell(lead, plan.column);
    if (resolved) {
      await writeCell(lead.id, columnKey, resolved);
      n++;
    }
  }
  return n;
}
