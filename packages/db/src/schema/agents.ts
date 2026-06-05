import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';

/**
 * agents — saved, reusable Dogis (Phase E §7). A configured cell-Dogi or a whole
 * goal-plan can be named and stored here, then reused across columns and tables.
 *
 * `kind` distinguishes a single cell-Dogi (`dogi`) from a goal-plan (`plan`);
 * `config` holds the matching JSON (the `columns.config` shape for a `dogi`, the
 * `dogi-plan` shape for a `plan`). Reuse is purely client-side — read the config
 * and pre-fill a new column/ask — so this table is a plain named store.
 */
export const agents = pgTable('agents', {
  id: id(),
  name: text('name').notNull(),
  /** 'dogi' (a single cell-Dogi config) | 'plan' (a goal-plan). */
  kind: text('kind').notNull(),
  /** The saved Dogi config or goal-plan, verbatim. */
  config: jsonb('config').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
