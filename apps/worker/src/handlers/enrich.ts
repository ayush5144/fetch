import { findReadyDependents, isCellEmpty, runCell } from '@fetch/columns';
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

  // On a successful fill, chain any now-runnable dependent dogi steps.
  if (filled) {
    const dependents = await findReadyDependents(data.leadId, data.columnKey);
    for (const columnKey of dependents) {
      await enqueue('enrich', { leadId: data.leadId, columnKey, apiKey: data.apiKey }, { leadId: data.leadId });
    }
  }
}
