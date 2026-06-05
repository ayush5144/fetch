import { jsonb, text } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { createdAt, id } from './_shared';

/**
 * sources — where a lead came from and the raw payload it arrived as.
 *
 * Storing the original payload means a bad header→field mapping can be
 * reprocessed without re-importing, and every lead can be traced to its origin.
 */
export const sources = pgTable('sources', {
  id: id(),
  /** csv | api | webhook | crm | manual */
  type: text('type').notNull(),
  /** The original payload exactly as received. */
  raw: jsonb('raw').notNull().default({}),
  createdAt: createdAt(),
});

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
