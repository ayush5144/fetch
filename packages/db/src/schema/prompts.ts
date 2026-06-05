import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id } from './_shared';

/**
 * prompts — versioned templates that instruct the LLM (enrichment agent or
 * personalization). Editing a prompt creates a NEW version row rather than
 * overwriting, so approved copy is never silently changed underneath a campaign.
 */
export const prompts = pgTable('prompts', {
  id: id(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  /** Template body with {{variables}}. */
  body: text('body').notNull(),
  /** Guardrails: { maxLength, requiredVars: string[], bannedClaims: string[] }. */
  guardrails: jsonb('guardrails').notNull().default({}),
  createdAt: createdAt(),
});

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
