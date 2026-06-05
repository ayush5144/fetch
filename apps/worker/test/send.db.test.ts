import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

// Mock the send adapter layer so no real network call is made. The fake records
// which leads it was asked to push and returns canned per-lead results.
const pushSpy = vi.fn();
vi.mock('@fetch/senders', () => ({
  getAdapter: () => ({ provider: 'instantly', available: true, push: pushSpy, parseEvent: () => null }),
}));

import { campaigns, db, events, leads, sources } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { ingestLead } from '@fetch/core';
import { sendHandler } from '../src/handlers/send';

/**
 * Phase 8 — sending. Exercises the send handler against a real Postgres with a
 * mocked adapter, proving it persists provider_lead_id + send_status on success,
 * records a `sent` event, marks per-lead failures without losing the batch, and
 * never re-sends a lead already marked sent.
 */
async function setup() {
  const [campaign] = await db
    .insert(campaigns)
    .values({ name: 'Test', provider: 'instantly', providerRef: 'ext-1' })
    .returning();
  const [src] = await db.insert(sources).values({ type: 'csv', raw: {} }).returning();

  const mk = async (email: string) => {
    const { lead } = await ingestLead(new CsvNormalizer().normalize(`email\n${email}`)[0]!, {
      sourceId: src!.id,
    });
    await db
      .update(leads)
      .set({ campaignId: campaign!.id, validationStatus: 'valid', approvalStatus: 'approved' })
      .where(eq(leads.id, lead.id));
    return lead.id;
  };

  return { campaignId: campaign!.id, a: await mk('a@acme.com'), b: await mk('b@acme.com') };
}

describe('send handler', () => {
  beforeEach(async () => {
    await truncateAll();
    pushSpy.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('persists provider_lead_id + sent status and records a sent event on success', async () => {
    const { campaignId, a } = await setup();
    pushSpy.mockResolvedValueOnce([{ leadId: a, ok: true, providerLeadId: 'p-A' }]);

    await sendHandler({ campaignId, leadIds: [a] });

    const lead = await db.query.leads.findFirst({ where: eq(leads.id, a) });
    expect(lead!.sendStatus).toBe('sent');
    expect(lead!.providerLeadId).toBe('p-A');
    expect(lead!.sentAt).toBeTruthy();

    const evs = await db.query.events.findMany({ where: eq(events.leadId, a) });
    expect(evs.map((e) => e.type)).toContain('sent');
  });

  it('marks a per-lead failure without losing the rest of the batch', async () => {
    const { campaignId, a, b } = await setup();
    pushSpy.mockResolvedValueOnce([
      { leadId: a, ok: true, providerLeadId: 'p-A' },
      { leadId: b, ok: false, error: 'rejected' },
    ]);

    await sendHandler({ campaignId, leadIds: [a, b] });

    const rows = await db.query.leads.findMany({ where: inArray(leads.id, [a, b]) });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sendStatus]));
    expect(byId[a]).toBe('sent');
    expect(byId[b]).toBe('failed');
  });

  it('never re-sends a lead already marked sent', async () => {
    const { campaignId, a, b } = await setup();
    // First send marks A sent.
    pushSpy.mockResolvedValueOnce([{ leadId: a, ok: true, providerLeadId: 'p-A' }]);
    await sendHandler({ campaignId, leadIds: [a] });

    // Second send over both — A must be excluded; only B reaches the adapter.
    pushSpy.mockResolvedValueOnce([{ leadId: b, ok: true, providerLeadId: 'p-B' }]);
    await sendHandler({ campaignId, leadIds: [a, b] });

    const pushedLeadIds = (pushSpy.mock.calls[1]![0] as { id: string }[]).map((l) => l.id);
    expect(pushedLeadIds).toEqual([b]); // A skipped (already sent)
  });
});
