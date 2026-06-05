import { integer, jsonb, text } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';

/**
 * accounts — the company a lead belongs to. Enriched once, shared across every
 * lead at that domain. `domain` is the dedupe key for companies.
 */
export const accounts = pgTable('accounts', {
  id: id(),
  /** Dedupe key for companies. Unique — two leads at one company share a row. */
  domain: text('domain').notNull().unique(),
  name: text('name'),
  industry: text('industry'),
  size: integer('size'),
  /** Detected technologies (text[]). */
  techStack: text('tech_stack').array(),
  /** Funding, hiring, news — discovered during account-level enrichment. */
  signals: jsonb('signals').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
