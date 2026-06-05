import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { createdAt, id } from './_shared';
import { leads } from './leads';

/**
 * events — tracked outcomes pushed back from send providers, normalized into
 * one internal vocabulary (sent/opened/clicked/replied/bounced/unsubscribed).
 *
 * `providerEvt` is the idempotency key: a redelivered webhook with the same
 * provider event id is deduped by the unique constraint, so it never
 * double-counts.
 */
export const events = pgTable(
  'events',
  {
    id: id(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** sent | opened | clicked | replied | bounced | unsubscribed */
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    /** The provider's unique event id — the idempotency key. */
    providerEvt: text('provider_evt').notNull().unique(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_lead_idx').on(t.leadId), index('events_type_idx').on(t.type)],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
