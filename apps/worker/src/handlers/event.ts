import { db, events, leads } from '@fetch/db';
import type { EventJobData } from '@fetch/core';
import { logger } from '@fetch/core';
import { getAdapter } from '@fetch/senders';
import { eq } from 'drizzle-orm';

/** Map a normalized event type to the lead timestamp column it sets. */
const TIMESTAMP_COLUMN = {
  opened: 'openedAt',
  clicked: 'clickedAt',
  replied: 'repliedAt',
  bounced: 'bouncedAt',
  unsubscribed: 'unsubscribedAt',
} as const;

/**
 * event handler — folds a provider webhook back into the lead row.
 *
 * Idempotency: the events table's unique `providerEvt` means a redelivered
 * webhook inserts nothing the second time (onConflictDoNothing), so it never
 * double-counts. We match the (possibly sparse) payload to the local lead by
 * email or provider_lead_id — Fetch already holds the full context.
 */
export async function eventHandler(data: EventJobData): Promise<void> {
  const adapter = getAdapter(data.provider as any);
  const parsed = adapter.parseEvent(data.raw);
  if (!parsed) {
    logger.warn('unrecognized webhook event, ignoring', { provider: data.provider });
    return;
  }

  // Match the event to a local lead.
  const lead = parsed.providerLeadId
    ? await db.query.leads.findFirst({ where: eq(leads.providerLeadId, parsed.providerLeadId) })
    : parsed.email
      ? await db.query.leads.findFirst({ where: eq(leads.email, parsed.email.toLowerCase()) })
      : undefined;
  if (!lead) {
    logger.warn('event for unknown lead, ignoring', { provider: data.provider });
    return;
  }

  // Insert the event idempotently. If it already exists, stop — no double work.
  const inserted = await db
    .insert(events)
    .values({
      leadId: lead.id,
      campaignId: lead.campaignId,
      type: parsed.type,
      provider: data.provider,
      providerEvt: parsed.providerEvt,
      payload: parsed.raw as object,
    })
    .onConflictDoNothing({ target: events.providerEvt })
    .returning({ id: events.id });

  if (inserted.length === 0) return; // duplicate delivery

  // Stamp the matching timestamp on the lead (sent has no dedicated column).
  const col = TIMESTAMP_COLUMN[parsed.type as keyof typeof TIMESTAMP_COLUMN];
  if (col) {
    await db
      .update(leads)
      .set({ [col]: new Date() })
      .where(eq(leads.id, lead.id));
  }
}
