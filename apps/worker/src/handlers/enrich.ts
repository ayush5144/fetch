import { deriveLeadEnrichmentStatus, findReadyDependents, isCellEmpty, runCell } from '@fetch/columns';
import { db, leads } from '@fetch/db';
import { enqueue, type EnrichJobData } from '@fetch/core';
import { eq } from 'drizzle-orm';

/**
 * enrich handler — resolves ONE user column for ONE lead.
 *
 * Idempotency + run-only-if-empty: we re-check the cell here, so a re-run (or a
 * duplicate delivery) that finds the cell already filled does no work and pays
 * nothing. runCell dispatches by column type (waterfall → agent / formula) and
 * writes the value with confidence + provenance back into the same lead row.
 *
 * Goal-mode chaining (Phase D): after a dogi cell is filled, any dogi column
 * whose `config.dependsOn` includes this column's key — and whose every
 * dependency is now filled for this lead, and whose own cell is empty — becomes
 * runnable, so we enqueue it. This chains a plan's step 2 to run only once step
 * 1 is done, per lead, reusing the same run-only-if-empty fan-out.
 *
 * Per-lead status (Phase J): a Dogi cell that misses records its own
 * `enrichmentConf[key] = { status:'failed', ... }` + an audit row inside runCell.
 * The single `leads.enrichmentStatus` is then DERIVED from all the lead's dogi
 * cells (deriveLeadEnrichmentStatus) instead of being last-writer-wins, so a
 * lead whose CEO filled but LinkedIn missed no longer flips the whole lead to a
 * misleading "failed"/"done" on the last cell that happened to run.
 */
export async function enrichHandler(data: EnrichJobData): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, data.leadId) });
  if (!lead) return; // lead deleted between enqueue and run — nothing to do

  // Run-only-if-empty guard, enforced again at execution time.
  if (!isCellEmpty(lead, data.columnKey)) return;

  await db.update(leads).set({ enrichmentStatus: 'running' }).where(eq(leads.id, data.leadId));

  // BYOK key, if the run carries one, is threaded to the column resolver for
  // this job only. It is never logged or persisted. runCell records a per-cell
  // failure marker + audit row on a miss (no value written → cell stays empty).
  const filled = await runCell(data.leadId, data.columnKey, { apiKey: data.apiKey });

  // Re-derive the lead's status from ALL its dogi cells, not just this one. A
  // null result means "no clear value" → leave the prior status as-is.
  const derived = await deriveLeadEnrichmentStatus(data.leadId);
  if (derived) {
    await db.update(leads).set({ enrichmentStatus: derived }).where(eq(leads.id, data.leadId));
  }

  // On a successful fill, chain any now-runnable dependent dogi steps.
  if (filled) {
    const dependents = await findReadyDependents(data.leadId, data.columnKey);
    for (const columnKey of dependents) {
      await enqueue('enrich', { leadId: data.leadId, columnKey, apiKey: data.apiKey }, { leadId: data.leadId });
    }
  }
}
