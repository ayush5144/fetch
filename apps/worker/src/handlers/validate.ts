import { db, leads } from '@fetch/db';
import type { ValidateJobData } from '@fetch/core';
import { audit } from '@fetch/core';
import { validateEmail } from '@fetch/validation';
import { eq } from 'drizzle-orm';

/**
 * validate handler — runs the deliverability checks for one lead and writes the
 * gating status. The status this sets is a HARD gate: only `valid` (opt-in
 * `risky`) becomes campaign-eligible downstream. Re-running simply recomputes
 * the same status, so it's safe to repeat.
 */
export async function validateHandler(data: ValidateJobData): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, data.leadId) });
  if (!lead) return;

  const result = await validateEmail(lead.email);

  await db
    .update(leads)
    .set({ validationStatus: result.status, validationDetail: result.detail })
    .where(eq(leads.id, data.leadId));

  await audit({
    actor: 'system',
    entity: 'lead',
    entityId: data.leadId,
    action: 'validate',
    diff: { validationStatus: { from: lead.validationStatus, to: result.status } },
  });
}
