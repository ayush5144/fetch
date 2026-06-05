import { Hono } from 'hono';
import { db, events, leads } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';

/**
 * /analytics — funnel metrics derived directly from the events table and lead
 * timestamps, so the numbers always match the source of truth (no separate
 * metrics store to drift). Deliverability, engagement, and conversion per
 * campaign all read from the same rows the inbox and table render.
 */
export const analyticsRoutes = new Hono();

/** Top-line counts across the whole workspace. */
analyticsRoutes.get('/overview', async (c) => {
  const [leadAgg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      valid: sql<number>`count(*) filter (where ${leads.validationStatus} = 'valid')::int`,
      sent: sql<number>`count(*) filter (where ${leads.sendStatus} = 'sent')::int`,
      replied: sql<number>`count(*) filter (where ${leads.repliedAt} is not null)::int`,
      bounced: sql<number>`count(*) filter (where ${leads.bouncedAt} is not null)::int`,
    })
    .from(leads);

  const eventRows = await db
    .select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events)
    .groupBy(events.type);

  return c.json({
    leads: leadAgg,
    events: Object.fromEntries(eventRows.map((r) => [r.type, r.n])),
  });
});

/** Per-campaign funnel: sent → opened → clicked → replied, plus bounces. */
analyticsRoutes.get('/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.campaignId, id))
    .groupBy(events.type);

  const counts = Object.fromEntries(rows.map((r) => [r.type, r.n])) as Record<string, number>;
  const sent = counts.sent ?? 0;
  const rate = (n: number) => (sent > 0 ? Number((n / sent).toFixed(3)) : 0);

  return c.json({
    campaignId: id,
    counts,
    rates: {
      openRate: rate(counts.opened ?? 0),
      clickRate: rate(counts.clicked ?? 0),
      replyRate: rate(counts.replied ?? 0),
      bounceRate: rate(counts.bounced ?? 0),
    },
  });
});
