import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';

/**
 * tables — a named grid in the workspace (Clay's "workbook tables"). A table
 * owns its own columns and leads, so the grid an operator works in is always one
 * table's rows + columns. Created and opened from the Overview.
 *
 * `settings` holds per-table config such as the dedupe policy (Phase G), kept as
 * JSONB so adding a setting never needs a migration.
 */
export const tables = pgTable('tables', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  /** Optional emoji/icon for the tab. */
  icon: text('icon'),
  /** Per-table settings, e.g. { dedupe: { mode: 'none' | 'columns' | 'company', keys } }. */
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Table = typeof tables.$inferSelect;
export type NewTable = typeof tables.$inferInsert;

/** The stable id of the default table that existing leads/columns backfill into. */
export const DEFAULT_TABLE_ID = 'tbl_default_leads';
