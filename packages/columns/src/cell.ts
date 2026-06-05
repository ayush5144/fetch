import { db, leads } from '@fetch/db';
import type { CellProvenance, Lead } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';

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
 * Write one cell's value + provenance back to the lead row using a JSONB merge,
 * so concurrent writes to *different* keys don't clobber each other. Returns the
 * updated lead.
 */
export async function writeCell(
  leadId: string,
  key: string,
  result: { value: unknown; confidence: number; source: string | null; provider?: string },
): Promise<void> {
  const provenance: CellProvenance = {
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
