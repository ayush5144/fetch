import { accounts, db, leads, tables } from '@fetch/db';
import type { Account, Lead } from '@fetch/db';
import { eq, sql } from 'drizzle-orm';
import { audit, diffOf } from './audit';
import type { CanonicalLead } from './types';

/**
 * How a table decides two incoming rows are "the same" (Phase G). Dedupe is now
 * an opt-in, operator-chosen policy — NOT a forced default. Six people from one
 * company are six valid leads unless the operator says otherwise.
 *
 * - `none`    — never merge; always create a new lead. The default.
 * - `columns` — merge when ALL of `keys` match an existing lead in the table
 *               (e.g. `keys: ['email']`), else create.
 * - `company` — `columns` keyed on email PLUS the by-domain account find-or-create
 *               (the old always-on behavior, now opt-in only for company tables).
 */
export type DedupePolicy = { mode: 'none' | 'columns' | 'company'; keys?: string[] };

/** The safe default when a table has no configured policy. */
const DEFAULT_POLICY: DedupePolicy = { mode: 'none' };

/** Read a table's stored dedupe policy from settings, defaulting to `none`. */
async function policyForTable(tableId: string): Promise<DedupePolicy> {
  const table = await db.query.tables.findFirst({ where: eq(tables.id, tableId) });
  const stored = (table?.settings as { dedupe?: DedupePolicy } | null)?.dedupe;
  return stored ?? DEFAULT_POLICY;
}

/** Map a canonical lead's value for a dedupe key column (system field or data[key]). */
function canonicalKeyValue(canonical: CanonicalLead, key: string): string | null {
  const fieldMap: Record<string, string | null | undefined> = {
    email: canonical.email,
    firstName: canonical.firstName,
    first_name: canonical.firstName,
    lastName: canonical.lastName,
    last_name: canonical.lastName,
    phone: canonical.phone,
    title: canonical.title,
    linkedinUrl: canonical.linkedinUrl,
    linkedin_url: canonical.linkedinUrl,
    domain: canonical.company?.domain,
  };
  const raw =
    key in fieldMap ? fieldMap[key] : (canonical.data?.[key] as string | null | undefined);
  const v = raw == null ? '' : String(raw).trim().toLowerCase();
  return v === '' ? null : v;
}

/** A lead's stored value for a dedupe key column (system field or data[key]). */
function leadKeyValue(lead: Lead, key: string): string | null {
  const fieldMap: Record<string, string | null | undefined> = {
    email: lead.email,
    firstName: lead.firstName,
    first_name: lead.firstName,
    lastName: lead.lastName,
    last_name: lead.lastName,
    phone: lead.phone,
    title: lead.title,
    linkedinUrl: lead.linkedinUrl,
    linkedin_url: lead.linkedinUrl,
  };
  const raw =
    key in fieldMap
      ? fieldMap[key]
      : ((lead.data as Record<string, unknown> | null)?.[key] as string | null | undefined);
  const v = raw == null ? '' : String(raw).trim().toLowerCase();
  return v === '' ? null : v;
}

/**
 * Find an existing lead in the table that matches the canonical on ALL `keys`
 * (every key non-empty and equal). Returns undefined when no key is usable or no
 * row matches — the caller then creates a new lead.
 */
async function findMatch(
  canonical: CanonicalLead,
  tableId: string,
  keys: string[],
): Promise<Lead | undefined> {
  const wanted = keys.map((key) => [key, canonicalKeyValue(canonical, key)] as const);
  // A key with no value can't establish identity — skip the whole match.
  if (wanted.length === 0 || wanted.some(([, v]) => v == null)) return undefined;

  const candidates = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
  return candidates.find((lead) => wanted.every(([key, v]) => leadKeyValue(lead, key) === v));
}

/**
 * Find-or-create the account for a canonical lead, keyed on company domain
 * (the company dedupe key). Two leads at one company share one accounts row.
 * Returns null when no domain is known — the lead simply has no account yet.
 */
export async function findOrCreateAccount(canonical: CanonicalLead): Promise<Account | null> {
  const domain = canonical.company?.domain?.trim().toLowerCase();
  if (!domain) return null;

  const existing = await db.query.accounts.findFirst({ where: eq(accounts.domain, domain) });
  if (existing) {
    // Backfill a name we didn't have before, but never overwrite existing data.
    if (!existing.name && canonical.company?.name) {
      await db
        .update(accounts)
        .set({ name: canonical.company.name })
        .where(eq(accounts.id, existing.id));
    }
    return existing;
  }

  const [created] = await db
    .insert(accounts)
    .values({ domain, name: canonical.company?.name ?? null })
    .returning();
  await audit({ entity: 'account', entityId: created!.id, action: 'create', diff: { domain } });
  return created!;
}

/** Only copy a source value over an empty target field — never clobber data. */
function fillIfEmpty<T>(current: T | null | undefined, incoming: T | null | undefined): T | null {
  if (current !== null && current !== undefined && current !== '') return current;
  return incoming ?? null;
}

/**
 * Ingest one canonical lead under the table's (or an explicitly passed) dedupe
 * policy (Phase G). Dedupe is OPT-IN:
 *
 * - `none` (default) → always create a new lead; six people from one company are
 *   six rows. No account is created.
 * - `columns` → merge into an existing lead when ALL `keys` match (fill empty
 *   system fields, shallow-merge user `data`); else create. No account.
 * - `company` → merge keyed on `email` AND find-or-create the by-domain account.
 *
 * When `ctx.dedupe` is omitted the policy is read from the table's
 * `settings.dedupe`, defaulting to `none`. Every path writes an audit_log entry.
 *
 * Returns the persisted lead and whether it was newly created — the caller uses
 * `created` plus what's missing to decide which jobs to enqueue.
 */
export async function ingestLead(
  canonical: CanonicalLead,
  ctx: { sourceId: string; tableId: string; actor?: string; dedupe?: DedupePolicy },
): Promise<{ lead: Lead; created: boolean }> {
  const policy = ctx.dedupe ?? (await policyForTable(ctx.tableId));
  const email = canonical.email?.trim().toLowerCase() || null;

  // Accounts are opt-in: only the `company` policy resolves the by-domain account.
  const account = policy.mode === 'company' ? await findOrCreateAccount(canonical) : null;

  // Pick the match key(s) for this policy. `none` never matches (always create);
  // `company` is email; `columns` uses the operator-chosen key columns.
  const matchKeys =
    policy.mode === 'company' ? ['email'] : policy.mode === 'columns' ? (policy.keys ?? []) : [];
  const existing =
    matchKeys.length > 0 ? await findMatch(canonical, ctx.tableId, matchKeys) : undefined;

  if (existing) {
    const merged = {
      firstName: fillIfEmpty(existing.firstName, canonical.firstName),
      lastName: fillIfEmpty(existing.lastName, canonical.lastName),
      phone: fillIfEmpty(existing.phone, canonical.phone),
      title: fillIfEmpty(existing.title, canonical.title),
      linkedinUrl: fillIfEmpty(existing.linkedinUrl, canonical.linkedinUrl),
      accountId: existing.accountId ?? account?.id ?? null,
      // Shallow-merge new user data without dropping existing keys.
      data: { ...(existing.data as object), ...(canonical.data ?? {}) },
    };
    const [updated] = await db
      .update(leads)
      .set(merged)
      .where(eq(leads.id, existing.id))
      .returning();
    await audit({
      actor: ctx.actor,
      entity: 'lead',
      entityId: existing.id,
      action: 'update',
      diff: diffOf(existing as Record<string, unknown>, merged),
    });
    return { lead: updated!, created: false };
  }

  const [created] = await db
    .insert(leads)
    .values({
      tableId: ctx.tableId,
      sourceId: ctx.sourceId,
      accountId: account?.id ?? null,
      firstName: canonical.firstName ?? null,
      lastName: canonical.lastName ?? null,
      email,
      phone: canonical.phone ?? null,
      title: canonical.title ?? null,
      linkedinUrl: canonical.linkedinUrl ?? null,
      // A lead with no email is valid — it just can't be sent to yet.
      validationStatus: email ? 'unchecked' : 'no_email',
      data: canonical.data ?? {},
    })
    .returning();
  await audit({
    actor: ctx.actor,
    entity: 'lead',
    entityId: created!.id,
    action: 'create',
    diff: { email, accountId: account?.id ?? null },
  });
  return { lead: created!, created: true };
}

/** Count leads at a domain — used by the account view and dedupe assertions. */
export async function leadCountForAccount(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(eq(leads.accountId, accountId));
  return row?.n ?? 0;
}
