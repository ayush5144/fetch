import type { CanonicalLead } from '@fetch/core';

/**
 * Maps a flat record (one CSV row, one webhook body) to a CanonicalLead using a
 * header→field mapping. Anything not mapped to a known system field lands in
 * `data` verbatim, so no source column is ever lost.
 */

/** The canonical system fields a header can map onto. */
export type CanonicalField =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'title'
  | 'linkedinUrl'
  | 'companyName'
  | 'companyDomain';

/** A header→field mapping. Headers not present here flow into `data`. */
export type HeaderMap = Record<string, CanonicalField>;

/** How one CSV header is handled by the import-mapping flow. */
export interface ImportColumnMapping {
  /** create a new column · map onto an existing column · ignore this header. */
  action: 'create' | 'map' | 'skip';
  /** Target leads.data key (create/map). Defaults to snake_case(header) on create. */
  key?: string;
  /** Display label for a created column. */
  label?: string;
  /** Fill method for a created column ('manual' default). */
  type?: string;
  /** Value type for a created column ('text' default), stored in config.valueType. */
  valueType?: string;
}

/** header → mapping decision, from the import UI. */
export type ImportMapping = Record<string, ImportColumnMapping>;

/**
 * Turn one raw CSV record into a CanonicalLead under an explicit import mapping.
 * Identity headers (email/name/company/domain/…) always normalize to system
 * fields. Non-identity headers follow their mapping: `create`/`map` write the
 * value into `data[key]`, `skip` drops it. The column DEFINITIONS for `create`
 * are ensured by the caller; this only places values.
 */
export function recordToCanonicalWithMapping(
  record: Record<string, string>,
  mapping: ImportMapping,
): CanonicalLead {
  const identity: Record<string, string> = {};
  const data: Record<string, unknown> = {};

  for (const [rawHeader, rawValue] of Object.entries(record)) {
    const value = (rawValue ?? '').trim();
    if (!value) continue;
    const header = rawHeader.trim();

    // Identity headers always go to system fields, regardless of the mapping.
    if (identityFieldFor(header)) {
      identity[header] = value;
      continue;
    }

    const m = mapping[header];
    if (!m || m.action === 'skip') continue;
    const key = (m.key && m.key.trim()) || snakeCase(header);
    data[key] = value;
  }

  // Reuse the alias-based mapper for the identity subset, then overlay data.
  const lead = mapRecord(identity);
  lead.data = { ...(lead.data ?? {}), ...data };
  return lead;
}

/** Common header aliases, so a plain CSV maps sensibly with no config. */
const DEFAULT_ALIASES: Record<string, CanonicalField> = {
  'first name': 'firstName',
  first_name: 'firstName',
  firstname: 'firstName',
  first: 'firstName',
  'last name': 'lastName',
  last_name: 'lastName',
  lastname: 'lastName',
  last: 'lastName',
  email: 'email',
  'email address': 'email',
  email_address: 'email',
  phone: 'phone',
  'phone number': 'phone',
  phone_number: 'phone',
  title: 'title',
  'job title': 'title',
  job_title: 'title',
  position: 'title',
  linkedin: 'linkedinUrl',
  'linkedin url': 'linkedinUrl',
  linkedin_url: 'linkedinUrl',
  company: 'companyName',
  'company name': 'companyName',
  company_name: 'companyName',
  organization: 'companyName',
  domain: 'companyDomain',
  'company domain': 'companyDomain',
  company_domain: 'companyDomain',
  website: 'companyDomain',
};

/**
 * Is this header a known identity field (email/name/company/domain/…)? Returns
 * the canonical field it maps onto, or null. The import-mapping flow uses this to
 * keep identity headers normalizing to system fields even when the operator maps
 * other headers to user columns.
 */
export function identityFieldFor(header: string): CanonicalField | null {
  return DEFAULT_ALIASES[header.trim().toLowerCase()] ?? null;
}

/** snake_case a free-text header into a safe column key (a-z, 0-9, _). */
export function snakeCase(header: string): string {
  return (
    header
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column'
  );
}

/** Best-effort domain extraction from a website/email-ish value. */
function toDomain(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes('@')) return v.split('@')[1] ?? null;
  return v
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0] || null;
}

/**
 * Convert one raw record to canonical. `explicitMap` (from the import UI) wins;
 * otherwise we fall back to alias detection on the header name.
 */
export function mapRecord(
  record: Record<string, string>,
  explicitMap: HeaderMap = {},
): CanonicalLead {
  const lead: CanonicalLead = { company: {}, data: {} };

  for (const [rawHeader, rawValue] of Object.entries(record)) {
    const value = (rawValue ?? '').trim();
    if (!value) continue;

    const header = rawHeader.trim();
    const field = explicitMap[header] ?? DEFAULT_ALIASES[header.toLowerCase()];

    switch (field) {
      case 'firstName':
        lead.firstName = value;
        break;
      case 'lastName':
        lead.lastName = value;
        break;
      case 'email':
        lead.email = value.toLowerCase();
        break;
      case 'phone':
        lead.phone = value;
        break;
      case 'title':
        lead.title = value;
        break;
      case 'linkedinUrl':
        lead.linkedinUrl = value;
        break;
      case 'companyName':
        lead.company!.name = value;
        break;
      case 'companyDomain':
        lead.company!.domain = toDomain(value);
        break;
      default:
        // Unmapped → a user column in `data`, keyed by the original header.
        lead.data![header] = value;
    }
  }

  // If no explicit domain but we have an email, derive the account domain.
  if (!lead.company!.domain && lead.email) {
    lead.company!.domain = toDomain(lead.email);
  }
  return lead;
}
