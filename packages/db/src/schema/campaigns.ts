import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';
import { prompts } from './prompts';

/**
 * campaigns — a structured outreach effort: template, targeting rules, and the
 * delivery provider. `rules` gates eligibility (e.g. only validationStatus =
 * valid). `provider` is resolved to a send adapter at send time.
 */
export const campaigns = pgTable('campaigns', {
  id: id(),
  name: text('name').notNull(),
  /** instantly | smartlead | smtp */
  provider: text('provider').notNull().default('instantly'),
  /** External campaign id at the provider. */
  providerRef: text('provider_ref'),
  templateId: text('template_id').references(() => prompts.id, { onDelete: 'set null' }),
  /** Eligibility rules, e.g. { validationStatus: ['valid'], requireApproved: true }. */
  rules: jsonb('rules').notNull().default({}),
  /** draft | active | paused */
  status: text('status').notNull().default('draft'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
