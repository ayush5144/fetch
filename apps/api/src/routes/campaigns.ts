import { Hono } from 'hono';
import { z } from 'zod';
import { campaigns, db, leads } from '@fetch/db';
import { audit, enqueue } from '@fetch/core';
import { isSendable } from '@fetch/validation';
import { and, desc, eq, inArray } from 'drizzle-orm';

/**
 * /campaigns — define an outreach effort and launch it. Launching does NOT send
 * inline: it selects eligible leads (validation gate + approval gate), then
 * enqueues a single send job the worker drains through the campaign's adapter.
 */
export const campaignsRoutes = new Hono();

campaignsRoutes.get('/', async (c) => {
  const rows = await db.query.campaigns.findMany({ orderBy: [desc(campaigns.createdAt)] });
  return c.json({ campaigns: rows });
});

const createSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['instantly', 'smartlead', 'smtp']).default('instantly'),
  providerRef: z.string().optional(),
  templateId: z.string().optional(),
  rules: z
    .object({ allowRisky: z.boolean().optional(), requireApproved: z.boolean().optional() })
    .default({}),
});

campaignsRoutes.post('/', async (c) => {
  const body = createSchema.parse(await c.req.json());
  const [created] = await db.insert(campaigns).values(body).returning();
  await audit({ entity: 'campaign', entityId: created!.id, action: 'create', diff: { name: body.name } });
  return c.json({ campaign: created }, 201);
});

const assignSchema = z.object({ leadIds: z.array(z.string()).min(1) });

/** Attach leads to a campaign so they can be personalized and sent. */
campaignsRoutes.post('/:id/leads', async (c) => {
  const id = c.req.param('id');
  const { leadIds } = assignSchema.parse(await c.req.json());
  await db.update(leads).set({ campaignId: id }).where(inArray(leads.id, leadIds));
  return c.json({ assigned: leadIds.length });
});

/** Generate personalized copy for this campaign's leads (one job per lead). */
campaignsRoutes.post('/:id/personalize', async (c) => {
  const id = c.req.param('id');
  const rows = await db.query.leads.findMany({ where: eq(leads.campaignId, id) });
  const jobIds: string[] = [];
  for (const lead of rows) {
    jobIds.push(
      await enqueue('personalize', { leadId: lead.id, campaignId: id }, { leadId: lead.id, campaignId: id }),
    );
  }
  return c.json({ enqueued: jobIds.length }, 202);
});

/**
 * Launch — gate, then enqueue a send. Eligibility is the hard part the gate
 * enforces: only `valid` (opt-in `risky`) AND, by policy, approved leads that
 * haven't already been sent are eligible. Non-eligible leads are simply not
 * included; nothing about them is sent.
 */
campaignsRoutes.post('/:id/launch', async (c) => {
  const id = c.req.param('id');
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!campaign) return c.json({ error: 'not found' }, 404);

  const rules = (campaign.rules as { allowRisky?: boolean; requireApproved?: boolean }) ?? {};
  const candidates = await db.query.leads.findMany({
    where: and(eq(leads.campaignId, id), eq(leads.sendStatus, 'none')),
  });

  const eligible = candidates.filter((l) => {
    if (!isSendable(l.validationStatus as any, rules.allowRisky ?? false)) return false;
    if ((rules.requireApproved ?? true) && l.approvalStatus !== 'approved') return false;
    return true;
  });

  if (eligible.length === 0) {
    return c.json({ launched: 0, reason: 'no eligible leads (check validation + approval)' });
  }

  await db
    .update(campaigns)
    .set({ status: 'active' })
    .where(eq(campaigns.id, id));
  const jobId = await enqueue(
    'send',
    { campaignId: id, leadIds: eligible.map((l) => l.id) },
    { campaignId: id },
  );
  await audit({ entity: 'campaign', entityId: id, action: 'launch', diff: { eligible: eligible.length } });
  return c.json({ launched: eligible.length, jobId }, 202);
});
