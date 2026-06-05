import { campaigns, db, events, leads } from '@fetch/db';
import type { SendJobData } from '@fetch/core';
import { audit, logger } from '@fetch/core';
import { getAdapter } from '@fetch/senders';
import { eq, inArray } from 'drizzle-orm';

/**
 * send handler — pushes approved + valid leads to the campaign's provider
 * through its adapter, then records the outcome on each lead. A provider error
 * on one lead is recorded as a failure without sinking the rest of the batch
 * (the adapter returns a per-lead result array).
 */
export async function sendHandler(data: SendJobData): Promise<void> {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, data.campaignId) });
  if (!campaign) return;

  const rows = await db.query.leads.findMany({ where: inArray(leads.id, data.leadIds) });
  if (rows.length === 0) return;

  // Skip anything already sent — makes the handler safe to run twice.
  const toSend = rows.filter((l) => l.sendStatus !== 'sent');
  if (toSend.length === 0) return;

  const adapter = getAdapter(campaign.provider as any);
  const results = await adapter.push(toSend, campaign);

  for (const result of results) {
    if (result.ok) {
      await db
        .update(leads)
        .set({
          sendStatus: 'sent',
          provider: campaign.provider,
          providerLeadId: result.providerLeadId ?? null,
          campaignId: campaign.id,
          sentAt: new Date(),
        })
        .where(eq(leads.id, result.leadId));

      // Record the `sent` event so analytics has a denominator immediately.
      await db
        .insert(events)
        .values({
          leadId: result.leadId,
          campaignId: campaign.id,
          type: 'sent',
          provider: campaign.provider,
          providerEvt: `sent:${campaign.provider}:${result.providerLeadId ?? result.leadId}`,
          payload: {},
        })
        .onConflictDoNothing({ target: events.providerEvt });
    } else {
      await db
        .update(leads)
        .set({ sendStatus: 'failed', provider: campaign.provider })
        .where(eq(leads.id, result.leadId));
      logger.warn('send failed for lead', { lead_id: result.leadId, err: result.error });
    }
  }

  await audit({
    actor: 'system',
    entity: 'campaign',
    entityId: campaign.id,
    action: 'send',
    diff: { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
  });
}
