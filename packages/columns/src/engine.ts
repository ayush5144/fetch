import { columns as columnsTable, db, leads } from '@fetch/db';
import type { Column, Lead } from '@fetch/db';
import { eq, inArray } from 'drizzle-orm';
import { isCellEmpty, writeCell } from './cell';
import { resolveCell } from './resolve';

/**
 * The run-column engine. "Running a column" = firing its job across rows.
 *
 * Two column kinds resolve WITHOUT a background job:
 *   - formula → derived locally, recomputed inline
 *   - manual  → a human types it, never auto-run
 * The other two (enrichment, agent) are slow/network and resolve in a worker,
 * so the API enqueues one job per row for them. `planRun` decides which leads
 * actually need a job, honoring run-only-if-empty.
 */

export async function getColumnByKey(key: string): Promise<Column | undefined> {
  return db.query.columns.findFirst({ where: eq(columnsTable.key, key) });
}

export interface RunPlan {
  column: Column;
  /** Leads whose cell is empty and therefore need resolving. */
  toRun: Lead[];
  /** Leads skipped because the cell already has a value (run-only-if-empty). */
  skipped: number;
}

/**
 * Decide what a run touches. `force` ignores run-only-if-empty (a deliberate
 * re-enrich). Returns the leads that need work, so the caller enqueues exactly
 * that many jobs — not the whole table.
 */
export async function planRun(
  columnKey: string,
  leadIds: string[],
  opts: { force?: boolean } = {},
): Promise<RunPlan | null> {
  const column = await getColumnByKey(columnKey);
  if (!column) return null;

  const rows = leadIds.length
    ? await db.query.leads.findMany({ where: inArray(leads.id, leadIds) })
    : await db.query.leads.findMany();

  const toRun = opts.force ? rows : rows.filter((l) => isCellEmpty(l, columnKey));
  return { column, toRun, skipped: rows.length - toRun.length };
}

/**
 * Resolve and persist a single cell for one lead — the unit a worker runs for
 * enrichment/agent columns, and what `runFormulaColumn` calls inline. Returns
 * whether a value was written.
 */
export async function runCell(leadId: string, columnKey: string): Promise<boolean> {
  const column = await getColumnByKey(columnKey);
  if (!column) return false;
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return false;

  const resolved = await resolveCell(lead, column);
  if (!resolved) return false;

  await writeCell(leadId, columnKey, resolved);
  return true;
}

/** Recompute a formula column inline for a set of leads (no jobs needed). */
export async function runFormulaColumn(columnKey: string, leadIds: string[]): Promise<number> {
  const plan = await planRun(columnKey, leadIds, { force: true });
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
