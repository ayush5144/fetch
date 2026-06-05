import { runCell } from '@fetch/columns';
import { db, leads } from '@fetch/db';
import type { EnrichJobData } from '@fetch/core';
import { isCellEmpty } from '@fetch/columns';
import { eq } from 'drizzle-orm';

/**
 * enrich handler — resolves ONE user column for ONE lead.
 *
 * Idempotency + run-only-if-empty: we re-check the cell here, so a re-run (or a
 * duplicate delivery) that finds the cell already filled does no work and pays
 * nothing. runCell dispatches by column type (waterfall → agent / formula) and
 * writes the value with confidence + provenance back into the same lead row.
 */
export async function enrichHandler(data: EnrichJobData): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, data.leadId) });
  if (!lead) return; // lead deleted between enqueue and run — nothing to do

  // Run-only-if-empty guard, enforced again at execution time.
  if (!isCellEmpty(lead, data.columnKey)) return;

  await db.update(leads).set({ enrichmentStatus: 'running' }).where(eq(leads.id, data.leadId));

  // BYOK key, if the run carries one, is threaded to the column resolver for
  // this job only. It is never logged or persisted.
  const filled = await runCell(data.leadId, data.columnKey, { apiKey: data.apiKey });

  await db
    .update(leads)
    .set({ enrichmentStatus: filled ? 'done' : 'failed' })
    .where(eq(leads.id, data.leadId));
}
