import { createId } from '@paralleldrive/cuid2';
import { text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Shared column builders so every table speaks the same dialect:
 *  - `id`        — a collision-resistant cuid2 primary key, generated app-side.
 *  - `createdAt` — set on insert, in UTC.
 *  - `updatedAt` — set on insert and bumped on update.
 *
 * Keeping these here means a schema change (e.g. switching PK strategy) is a
 * one-line edit, not a sweep across ten files.
 */

/** Primary key: an app-generated cuid2. */
export const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => createId());

/** A cuid2-typed foreign-key column (nullability decided by the caller). */
export const cuid = (name: string) => text(name);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Enum value sets ──────────────────────────────────────────────────────────
// These mirror the status vocabularies in ARCHITECTURE.md. They are kept as
// const tuples (not pg enums) so adding a value never needs a migration — the
// engine validates them in code where the meaning lives.

export const ENRICHMENT_STATUS = ['pending', 'running', 'done', 'failed'] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUS)[number];

export const VALIDATION_STATUS = [
  'valid',
  'risky',
  'invalid',
  'disposable',
  'duplicate',
  'no_email',
  'unchecked',
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUS)[number];

export const APPROVAL_STATUS = ['draft', 'ready', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const SEND_STATUS = ['none', 'queued', 'sent', 'failed'] as const;
export type SendStatus = (typeof SEND_STATUS)[number];

export const PROVIDER = ['instantly', 'smartlead', 'smtp'] as const;
export type Provider = (typeof PROVIDER)[number];

export const COLUMN_TYPE = ['enrichment', 'agent', 'formula', 'manual'] as const;
export type ColumnType = (typeof COLUMN_TYPE)[number];

export const JOB_TYPE = ['enrich', 'validate', 'personalize', 'send', 'event'] as const;
export type JobType = (typeof JOB_TYPE)[number];

export const JOB_STATUS = ['queued', 'active', 'completed', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const EVENT_TYPE = [
  'sent',
  'opened',
  'clicked',
  'replied',
  'bounced',
  'unsubscribed',
] as const;
export type EventType = (typeof EVENT_TYPE)[number];

export const SOURCE_TYPE = ['csv', 'api', 'webhook', 'crm', 'manual'] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];

export const CAMPAIGN_STATUS = ['draft', 'active', 'paused'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];
