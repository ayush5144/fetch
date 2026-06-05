import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';
import { id } from './_shared';
import { prompts } from './prompts';

/**
 * sequences — the ordered steps and timing inside a campaign. Each step points
 * at the prompt used to generate that touch and how many days to wait first.
 */
export const sequences = pgTable('sequences', {
  id: id(),
  campaignId: text('campaign_id')
    .notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  step: integer('step').notNull(),
  waitDays: integer('wait_days').notNull().default(0),
  promptId: text('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
});

export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;
