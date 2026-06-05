import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { createdAt, id } from './_shared';
import { leads } from './leads';

/**
 * jobs — a mirror of background work for the UI's Job Monitor.
 *
 * pg-boss owns the actual queue mechanics (claim, retry, backoff) inside its
 * own schema. This table is the *observable* projection the operator sees:
 * every enqueue writes a row here, and the worker transitions it
 * queued → active → completed | failed | dead. That keeps the queue internals
 * out of the UI while still surfacing status, errors, and dead-letters.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    /** enrich | validate | personalize | send | event */
    type: text('type').notNull(),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** queued | active | completed | failed | dead */
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** Last failure reason, surfaced in the Job Monitor. */
    error: text('error'),
    /** Arbitrary job input/result for inspection and replay. */
    payload: jsonb('payload').notNull().default({}),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_type_idx').on(t.type),
    index('jobs_lead_idx').on(t.leadId),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
