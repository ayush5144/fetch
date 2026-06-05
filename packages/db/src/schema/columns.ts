import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';

/**
 * columns — the DYNAMIC COLUMN ENGINE definitions.
 *
 * A column is not just where a value lives — it is the definition of *how that
 * value gets filled*. Adding a column = defining a reusable job; running a
 * column = firing that job across every row. Values land in `leads.data[key]`;
 * the definition lives here.
 */
export const columns = pgTable('columns', {
  id: id(),
  /** The JSONB key written into leads.data. Unique across the table. */
  key: text('key').notNull().unique(),
  /** Display name shown as the column header. */
  label: text('label').notNull(),
  /** enrichment | agent | formula | manual */
  type: text('type').notNull(),
  /**
   * Type-specific configuration:
   *  - enrichment → { field, providers: string[] } (waterfall order)
   *  - agent      → { prompt, outputField }
   *  - formula    → { expression, dependsOn: string[] }
   *  - manual     → {}
   */
  config: jsonb('config').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Column = typeof columns.$inferSelect;
export type NewColumn = typeof columns.$inferInsert;
