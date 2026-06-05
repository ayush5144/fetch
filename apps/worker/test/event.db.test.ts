import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, db, events, leads, sources } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { ingestLead } from '@fetch/core';
import { eventHandler } from '../src/handlers/event';

/**
 * Phase 9 — event feedback. Exercises the worker's event handler end-to-end
 * against a real Postgres, using the real (pure) Instantly parseEvent — no
 * network. Proves normalization, idempotency by providerEvt, sparse-payload
 * lead matching by email, and lead timestamp stamping.
 */
async function makeLead(email: string): Promise<string> {
  const [src] = await db.insert(sources).values({ type: 'csv', raw: {} }).returning();
  const { lead } = await ingestLead(new CsvNormalizer().normalize(`email\n${email}`)[0]!, {
    sourceId: src!.id,
    tableId: DEFAULT_TABLE_ID,
  });
  return lead.id;
}

describe('event handler', () => {
  beforeEach(truncateAll);

  it('normalizes an Instantly open, matches the lead by email, and stamps openedAt', async () => {
    const id = await makeLead('ava@acme.com');
    await eventHandler({
      provider: 'instantly',
      raw: { event_type: 'email_opened', id: 'evt-1', lead_email: 'ava@acme.com' },
    });

    const evs = await db.query.events.findMany({ where: eq(events.leadId, id) });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe('opened');

    const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(lead!.openedAt).toBeTruthy();
  });

  it('is idempotent: the same provider event delivered twice inserts one row', async () => {
    const id = await makeLead('ava@acme.com');
    const payload = { event_type: 'email_opened', id: 'dup-1', lead_email: 'ava@acme.com' };
    await eventHandler({ provider: 'instantly', raw: payload });
    await eventHandler({ provider: 'instantly', raw: payload });

    const evs = await db.query.events.findMany({ where: eq(events.leadId, id) });
    expect(evs).toHaveLength(1); // deduped by providerEvt
  });

  it('stamps repliedAt for a reply event', async () => {
    const id = await makeLead('ava@acme.com');
    await eventHandler({
      provider: 'instantly',
      raw: { event_type: 'reply_received', id: 'evt-2', lead_email: 'ava@acme.com' },
    });
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(lead!.repliedAt).toBeTruthy();
  });

  it('ignores an unknown event type without inserting a row', async () => {
    const id = await makeLead('ava@acme.com');
    await eventHandler({
      provider: 'instantly',
      raw: { event_type: 'totally_made_up', id: 'evt-3', lead_email: 'ava@acme.com' },
    });
    const evs = await db.query.events.findMany({ where: eq(events.leadId, id) });
    expect(evs).toHaveLength(0);
  });

  it('ignores an event for a lead it cannot match', async () => {
    await makeLead('ava@acme.com');
    await eventHandler({
      provider: 'instantly',
      raw: { event_type: 'email_opened', id: 'evt-4', lead_email: 'nobody@elsewhere.com' },
    });
    const all = await db.query.events.findMany();
    expect(all).toHaveLength(0);
  });
});
