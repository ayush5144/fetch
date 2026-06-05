import type { JobType } from '@fetch/db';

/**
 * The canonical shape every ingestion source normalizes into. A `Normalizer`
 * (CSV, webhook, CRM, manual) maps its raw payload to this, and the ingestion
 * pipeline dedupes + persists it. Identical input from two sources must produce
 * an identical CanonicalLead.
 */
export interface CanonicalLead {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  linkedinUrl?: string | null;
  /** Company fields used to find-or-create the account. */
  company?: {
    name?: string | null;
    domain?: string | null;
  };
  /** Any unmapped source columns; these land in leads.data verbatim. */
  data?: Record<string, unknown>;
}

/**
 * A Normalizer turns one source's raw rows into canonical leads. Connectors
 * implement this so every downstream stage can be written once and work for
 * every source.
 */
export interface Normalizer<TRaw = unknown> {
  readonly sourceType: 'csv' | 'api' | 'webhook' | 'crm' | 'manual';
  normalize(raw: TRaw): CanonicalLead | CanonicalLead[];
}

// ── Job payloads ─────────────────────────────────────────────────────────────
// The typed contract for what each queue carries. The API enqueues these; the
// worker handlers consume them. Keeping them here means both sides share a type.

export interface EnrichJobData {
  leadId: string;
  /** The user column being filled (its key in leads.data). */
  columnKey: string;
}

export interface ValidateJobData {
  leadId: string;
}

export interface PersonalizeJobData {
  leadId: string;
  campaignId: string;
}

export interface SendJobData {
  campaignId: string;
  leadIds: string[];
}

export interface EventJobData {
  provider: string;
  /** Raw provider webhook body, parsed by the adapter's parseEvent. */
  raw: unknown;
}

/** Maps a queue/job type to the payload it carries. */
export interface JobDataMap {
  enrich: EnrichJobData;
  validate: ValidateJobData;
  personalize: PersonalizeJobData;
  send: SendJobData;
  event: EventJobData;
}

export type JobData<T extends JobType = JobType> = JobDataMap[T];
