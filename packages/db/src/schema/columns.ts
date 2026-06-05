import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';
import { tables } from './tables';

/**
 * columns — the DYNAMIC COLUMN ENGINE definitions.
 *
 * A column is not just where a value lives — it is the definition of *how that
 * value gets filled*. Adding a column = defining a reusable job; running a
 * column = firing that job across every row. Values land in `leads.data[key]`;
 * the definition lives here. Columns are scoped to a table, so `key` is unique
 * per `(table_id, key)` — two tables can each have a `company` column.
 */
export const columns = pgTable(
  'columns',
  {
    id: id(),
    /** Which table this column belongs to (Phase A multi-table). */
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    /** The JSONB key written into leads.data. Unique within its table. */
    key: text('key').notNull(),
    /** Display name shown as the column header. Unique within its table. */
    label: text('label').notNull(),
    /**
     * Fill method: dogi | formula | manual (plus, for typed manual cells, the
     * value type lives in `config.valueType`: text|email|url|number|date|select).
     * (Legacy: enrichment | agent — migrated into `dogi`.)
     */
    type: text('type').notNull(),
    /**
     * Type-specific configuration:
     *  - dogi    → { instruction, reads, output, sources, policy, brain, ... }
     *  - formula → { kind, expr | parts | fields }
     *  - manual  → { valueType }
     */
    config: jsonb('config').notNull().default({}),
    /** Left-to-right order in the grid. Lower = further left. */
    position: integer('position').notNull().default(0),
    /** Persisted pixel width of the column header (null = grid default). */
    width: integer('width'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A column key and label are each unique within their table, not globally.
    uniqueIndex('columns_table_key_idx').on(t.tableId, t.key),
    uniqueIndex('columns_table_label_idx').on(t.tableId, t.label),
  ],
);

export type Column = typeof columns.$inferSelect;
export type NewColumn = typeof columns.$inferInsert;
