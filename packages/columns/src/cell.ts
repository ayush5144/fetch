import { db, leads } from '@fetch/db';
import type { CellProvenance, Lead } from '@fetch/db';
import { eq, inArray, sql } from 'drizzle-orm';

/**
 * Cell-level read/write helpers for user columns. A "cell" is one key inside
 * `leads.data`, with its trust metadata mirrored under `leads.enrichmentConf`.
 * Enriching in place means we update the same lead row, never a parallel table.
 */

/** Is the cell empty? Drives run-only-if-empty so re-runs don't re-pay. */
export function isCellEmpty(lead: Lead, key: string): boolean {
  const data = (lead.data as Record<string, unknown>) ?? {};
  const v = data[key];
  return v === undefined || v === null || v === '';
}

/**
 * Read a cell's per-cell status from `enrichmentConf[key]`.
 *
 * Back-compat: an entry that carries `confidence`/`source` but no explicit
 * `status` is treated as **filled** (legacy cells written before per-cell status
 * existed). An entirely absent entry means the cell was never run (empty). We do
 * NOT migrate-rewrite legacy entries — writers add `status` going forward.
 */
export function cellStatusOf(lead: Lead, key: string): 'filled' | 'failed' | 'pending' | null {
  const conf = (lead.enrichmentConf as Record<string, unknown>) ?? {};
  const entry = conf[key] as Record<string, unknown> | undefined;
  if (!entry) return null; // never run
  if (entry.status === 'failed') return 'failed';
  if (entry.status === 'filled') return 'filled';
  // Legacy: has provenance but no status ⇒ filled.
  if (entry.confidence !== undefined || entry.source !== undefined) return 'filled';
  return 'pending';
}

/**
 * Write one cell's value + provenance back to the lead row using a JSONB merge,
 * so concurrent writes to *different* keys don't clobber each other. Stamps
 * `status:'filled'` so a successful cell is unambiguous (vs a failed one).
 */
export async function writeCell(
  leadId: string,
  key: string,
  result: { value: unknown; confidence: number; source: string | null; provider?: string },
): Promise<void> {
  const provenance: CellProvenance = {
    status: 'filled',
    confidence: result.confidence,
    source: result.source,
    provider: result.provider,
    filledAt: new Date().toISOString(),
  };

  // jsonb_set on both data and enrichmentConf in a single statement.
  await db
    .update(leads)
    .set({
      data: sql`jsonb_set(${leads.data}, ${`{${key}}`}, ${JSON.stringify(result.value)}::jsonb, true)`,
      enrichmentConf: sql`jsonb_set(${leads.enrichmentConf}, ${`{${key}}`}, ${JSON.stringify(
        provenance,
      )}::jsonb, true)`,
    })
    .where(eq(leads.id, leadId));
}

/**
 * Mark a cell as **failed** in `enrichmentConf[key]` WITHOUT writing any value
 * into `data[key]`. Keeping `data` untouched means `isCellEmpty` stays true, so
 * a failed cell re-runs naturally and the GRID can distinguish a tried-and-empty
 * cell from a never-run one. `error` is a short human reason; `at` is an ISO
 * timestamp (app runtime — not the workflow sandbox, so Date is fine here).
 */
export async function writeCellFailure(leadId: string, key: string, error: string): Promise<void> {
  const failure = { status: 'failed' as const, error, at: new Date().toISOString() };
  await db
    .update(leads)
    .set({
      enrichmentConf: sql`jsonb_set(${leads.enrichmentConf}, ${`{${key}}`}, ${JSON.stringify(
        failure,
      )}::jsonb, true)`,
    })
    .where(eq(leads.id, leadId));
}

/**
 * Clear a cell: drop `key` from BOTH `data` and `enrichmentConf` for the given
 * leads, so it reads as never-run (empty). Used by the "force" re-run path —
 * after clearing, run-only-if-empty re-enqueues the cell. The `-` operator
 * removes a top-level JSONB key (a no-op when absent). One UPDATE per call,
 * scoped to the passed lead ids; a missing/empty list is a no-op.
 */
export async function clearCells(leadIds: string[], key: string): Promise<void> {
  if (leadIds.length === 0) return;
  await db
    .update(leads)
    .set({
      data: sql`${leads.data} - ${key}`,
      enrichmentConf: sql`${leads.enrichmentConf} - ${key}`,
    })
    .where(inArray(leads.id, leadIds));
}
