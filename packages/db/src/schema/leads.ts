import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { campaigns } from './campaigns';
import { createdAt, id, updatedAt } from './_shared';
import { sources } from './sources';

/**
 * leads — THE SPINE. One person who may be contacted, carrying the state of
 * every stage it has been through.
 *
 * The dividing line is `data`: everything above it is a SYSTEM column (fixed,
 * typed, and reasoned about by the engine — validation gates on `email`,
 * sending gates on `validationStatus`). Everything inside `data` is a USER
 * column the operator defined in the UI. We enrich IN PLACE — values are
 * written back into this row, never into a parallel `enriched_leads` table.
 */
export const leads = pgTable(
  'leads',
  {
    id: id(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),

    // ── Identity ────────────────────────────────────────────────────────────
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    linkedinUrl: text('linkedin_url'),

    // ── Enrichment state ──────────────────────────────────────────────────────
    enrichmentStatus: text('enrichment_status').notNull().default('pending'),
    /** Per-field confidence + provenance URLs, e.g. { company_size: { confidence, source } }. */
    enrichmentConf: jsonb('enrichment_conf').notNull().default({}),

    // ── Validation state ──────────────────────────────────────────────────────
    validationStatus: text('validation_status').notNull().default('unchecked'),
    /** Raw validation detail: mx, smtp, disposable, catchAll flags. */
    validationDetail: jsonb('validation_detail').notNull().default({}),

    // ── Personalization ───────────────────────────────────────────────────────
    subject: text('subject'),
    body: text('body'),
    promptVersion: text('prompt_version'),
    approvalStatus: text('approval_status').notNull().default('draft'),

    // ── Sending state ─────────────────────────────────────────────────────────
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    provider: text('provider'),
    providerLeadId: text('provider_lead_id'),
    sendStatus: text('send_status').notNull().default('none'),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    // ── Event state (written by event intake) ─────────────────────────────────
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),

    // ── User columns ──────────────────────────────────────────────────────────
    /** ALL user-defined columns live here, keyed by columns.key. GIN-indexed. */
    data: jsonb('data').notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Email is the lead-level dedupe key. Partial unique so many no-email leads
    // can coexist (NULLs are distinct, but we guard re-imports in code too).
    index('leads_email_idx').on(t.email),
    index('leads_account_idx').on(t.accountId),
    index('leads_validation_idx').on(t.validationStatus),
    index('leads_campaign_idx').on(t.campaignId),
    // GIN index so filters on user columns (data->>'company_size') use an index.
    index('leads_data_gin_idx').using('gin', t.data),
  ],
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

/**
 * Shape of a single enriched cell's provenance, stored under
 * `enrichmentConf[key]` and mirrored into `data[key]` as the value.
 */
export interface CellProvenance {
  confidence: number;
  source: string | null;
  provider?: string;
  filledAt?: string;
}

/** Convenience SQL fragment for the GIN-indexed JSONB containment operator. */
export const dataContains = (obj: Record<string, unknown>) =>
  sql`${leads.data} @> ${JSON.stringify(obj)}::jsonb`;
