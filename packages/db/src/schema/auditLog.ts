import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id } from './_shared';

/**
 * audit_log — append-only history of what changed, when, and by whom. This is
 * where history lives; we never keep a parallel copy of a lead to track its
 * past. Every create / update / approve / send writes one row with a diff.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    /** user id | "system" | job id */
    actor: text('actor').notNull().default('system'),
    /** lead | account | campaign | job | column | prompt … */
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    /** create | update | approve | reject | send … */
    action: text('action').notNull(),
    /** The before/after diff of the change. */
    diff: jsonb('diff').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId)],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
