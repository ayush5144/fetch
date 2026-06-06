import { accounts, db, leads, tables } from '@fetch/db';
import type { Account, Lead } from '@fetch/db';
import { and, eq, sql } from 'drizzle-orm';
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
 * Resolve the policy's match keys (mirrors `ingestLead`) and find an existing
 * lead the canonical would dedupe INTO, or undefined. Lets a caller know, before
 * inserting, whether a row is genuinely new under the table's dedupe policy.
 */
async function findPolicyMatch(
  canonical: CanonicalLead,
  tableId: string,
  policy: DedupePolicy,
): Promise<Lead | undefined> {
  const matchKeys =
    policy.mode === 'company' ? ['email'] : policy.mode === 'columns' ? (policy.keys ?? []) : [];
  if (matchKeys.length === 0) return undefined;
  return findMatch(canonical, tableId, matchKeys);
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
 * Merge a source lead's fields INTO a keeper, only where the keeper is currently
 * empty/null — never clobbering existing keeper data. Shallow-merges user `data`
 * (keeper keys win). Shared by ingest-time dedupe and existing-row dedupe.
 */
function mergeLeadFields(
  keeper: Lead,
  source: Pick<
    Lead,
    'firstName' | 'lastName' | 'email' | 'phone' | 'title' | 'linkedinUrl' | 'accountId' | 'data'
  >,
): Pick<
  Lead,
  'firstName' | 'lastName' | 'email' | 'phone' | 'title' | 'linkedinUrl' | 'accountId' | 'data'
> {
  return {
    firstName: fillIfEmpty(keeper.firstName, source.firstName),
    lastName: fillIfEmpty(keeper.lastName, source.lastName),
    email: fillIfEmpty(keeper.email, source.email),
    phone: fillIfEmpty(keeper.phone, source.phone),
    title: fillIfEmpty(keeper.title, source.title),
    linkedinUrl: fillIfEmpty(keeper.linkedinUrl, source.linkedinUrl),
    accountId: keeper.accountId ?? source.accountId ?? null,
    // Fill only keeper-empty data keys; existing keeper values are preserved.
    data: {
      ...((source.data as Record<string, unknown> | null) ?? {}),
      ...((keeper.data as Record<string, unknown> | null) ?? {}),
    },
  };
}

/** Result of a dedupe-existing-rows pass (preview or applied). */
export interface DedupeResult {
  /** Number of duplicate-value clusters acted on (clusters of size ≥ 2). */
  groups: number;
  /** Rows removed (merged away) — sum over clusters of (clusterSize − 1). */
  merged: number;
  /** Keeper rows (one per acted-on cluster). */
  kept: number;
  /** Alias of `merged` — total rows that would be merged away (GET preview). */
  rows: number;
}

/**
 * Dedupe rows that ALREADY exist in a table by one or more key columns — the
 * Clay-style "Dedupe by this column" action (NOT ingest-time dedupe).
 *
 * Groups the table's rows by the tuple of values for `keys` (each key read from
 * the lead's system field when it is one, else from `data[key]`; string values
 * normalized by trim + lowercase). Rows where ANY key value is empty/null are
 * never duplicates and are left untouched.
 *
 * In each cluster of size ≥ 2 it KEEPS the OLDEST row (min `createdAt`, tiebreak
 * by `id`), merges every other row's fields into the keeper ONLY where the
 * keeper is empty (never clobbering existing keeper data), then DELETES the
 * non-keepers. Writes an `update` audit on a keeper that absorbed fields and a
 * `delete` audit on each removed row. Every query is scoped by `table_id`.
 *
 * `dryRun: true` computes the same counts WITHOUT mutating (powers the preview).
 * Idempotent: a second consecutive run yields `merged: 0`.
 */
export async function dedupeExistingRows(
  tableId: string,
  keys: string[],
  opts?: { dryRun?: boolean; actor?: string },
): Promise<DedupeResult> {
  const dryRun = opts?.dryRun ?? false;
  const empty: DedupeResult = { groups: 0, merged: 0, kept: 0, rows: 0 };
  if (keys.length === 0) return empty;

  const rows = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });

  // Bucket rows by their normalized key tuple. Rows with any empty key value are
  // skipped — they can never be duplicates.
  const clusters = new Map<string, Lead[]>();
  for (const lead of rows) {
    const values = keys.map((key) => leadKeyValue(lead, key));
    if (values.some((v) => v == null)) continue;
    const bucket = JSON.stringify(values);
    (clusters.get(bucket) ?? clusters.set(bucket, []).get(bucket)!).push(lead);
  }

  let groups = 0;
  let merged = 0;
  let kept = 0;

  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    groups += 1;
    kept += 1;

    // Keeper = oldest (min createdAt), tiebreak by id for determinism.
    const ordered = [...members].sort((a, b) => {
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const keeper = ordered[0]!;
    const dupes = ordered.slice(1);
    merged += dupes.length;

    if (dryRun) continue;

    // Absorb each dupe's fields into the keeper, only filling empties. Apply the
    // dupes in order so the oldest dupe's value wins a contested empty field.
    let working = keeper;
    let changed = false;
    for (const dupe of dupes) {
      const next = mergeLeadFields(working, dupe);
      const diff = diffOf(working as unknown as Record<string, unknown>, next);
      if (Object.keys(diff).length > 0) changed = true;
      working = { ...working, ...next };
    }

    if (changed) {
      const set = {
        firstName: working.firstName,
        lastName: working.lastName,
        email: working.email,
        phone: working.phone,
        title: working.title,
        linkedinUrl: working.linkedinUrl,
        accountId: working.accountId,
        data: working.data,
      };
      await db.update(leads).set(set).where(eq(leads.id, keeper.id));
      await audit({
        actor: opts?.actor,
        entity: 'lead',
        entityId: keeper.id,
        action: 'update',
        diff: diffOf(keeper as unknown as Record<string, unknown>, set),
      });
    }

    // Delete the non-keepers, scoped to this table so a stray id can't reach out.
    for (const dupe of dupes) {
      await db.delete(leads).where(and(eq(leads.id, dupe.id), eq(leads.tableId, tableId)));
      await audit({
        actor: opts?.actor,
        entity: 'lead',
        entityId: dupe.id,
        action: 'delete',
        diff: { mergedInto: keeper.id, tableId },
      });
    }
  }

  return { groups, merged, kept, rows: merged };
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

/**
 * Map one row-sourcing object (e.g. `{ company: "Apple" }`) to a CanonicalLead.
 * A recognized primary field (company / name / email) lands on its canonical
 * system slot so the table's dedupe policy and downstream stages see it; every
 * other key is preserved verbatim in `data` so Dogi columns can read it.
 */
function sourcedRowToCanonical(row: Record<string, unknown>): CanonicalLead {
  const data: Record<string, unknown> = { ...row };
  const canonical: CanonicalLead = {};

  const take = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return undefined;
  };

  const company = take('company', 'company_name', 'organization');
  if (company) {
    canonical.company = { name: company };
    delete data.company;
    delete data.company_name;
    delete data.organization;
    // Keep the canonical name addressable by Dogi columns that read `company`.
    data.company = company;
  }

  const email = take('email');
  if (email) {
    canonical.email = email;
    delete data.email;
  }

  // A "name" maps to first/last so person-style lists become real leads.
  const name = take('name', 'full_name', 'person');
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    canonical.firstName = first ?? null;
    canonical.lastName = rest.length ? rest.join(' ') : null;
    delete data.name;
    delete data.full_name;
    delete data.person;
    data.name = name;
  }

  canonical.data = data;
  return canonical;
}

/** How many rows a sourcing insert created vs merged into existing leads. */
export interface SourcedRowsResult {
  created: number;
  merged: number;
  /** Blank seed rows that were filled in place (counted toward `created`). */
  filled: number;
}

/**
 * A "blank" lead is the one a fresh table is seeded with: no email AND no
 * meaningful `data` keys. It's a guaranteed-failing empty row, so when Doggo
 * sources entities we fill it in place instead of leaving it as a dead first row.
 */
function isBlankLead(lead: Lead): boolean {
  if (lead.email && lead.email.trim() !== '') return false;
  if (lead.firstName || lead.lastName || lead.phone || lead.title || lead.linkedinUrl) return false;
  const data = (lead.data as Record<string, unknown> | null) ?? {};
  for (const v of Object.values(data)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return false;
  }
  return true;
}

/**
 * Find the table's oldest blank lead (no email, no meaningful data), or undefined.
 * Used to reuse the seeded blank row instead of appending alongside it.
 */
async function findBlankLead(tableId: string): Promise<Lead | undefined> {
  const rows = await db.query.leads.findMany({ where: eq(leads.tableId, tableId) });
  const blanks = rows.filter(isBlankLead);
  if (blanks.length === 0) return undefined;
  return blanks.sort((a, b) => {
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * Write a sourced canonical row INTO an existing blank lead (the seeded row),
 * keeping its position so it stays the first row. Goes through the same merge
 * shape as ingest-time dedupe and writes an `update` audit. Returns the row.
 */
async function fillBlankLead(
  blank: Lead,
  canonical: CanonicalLead,
  actor?: string,
): Promise<Lead> {
  const set = {
    firstName: fillIfEmpty(blank.firstName, canonical.firstName),
    lastName: fillIfEmpty(blank.lastName, canonical.lastName),
    email: fillIfEmpty(blank.email, canonical.email),
    phone: fillIfEmpty(blank.phone, canonical.phone),
    title: fillIfEmpty(blank.title, canonical.title),
    linkedinUrl: fillIfEmpty(blank.linkedinUrl, canonical.linkedinUrl),
    // The blank row has no meaningful data — take the sourced object wholesale.
    data: { ...((blank.data as Record<string, unknown> | null) ?? {}), ...(canonical.data ?? {}) },
    // A blank row was 'no_email'; if we now have an email, it's unchecked again.
    validationStatus: canonical.email ? 'unchecked' : blank.validationStatus,
  };
  const [updated] = await db.update(leads).set(set).where(eq(leads.id, blank.id)).returning();
  await audit({
    actor,
    entity: 'lead',
    entityId: blank.id,
    action: 'update',
    diff: diffOf(blank as unknown as Record<string, unknown>, set),
  });
  return updated!;
}

/**
 * Insert a batch of row-sourcing objects (from `sourceRows`) as leads in a
 * table, REUSING `ingestLead` so the table's dedupe policy applies — re-running
 * "top 10 companies" must NOT duplicate. Each insert is audited.
 *
 * Blank-row reuse (R1.2): a freshly created table holds ONE blank seed lead (no
 * email, empty data). Rather than append N rows beside it (→ N+1 with a dead
 * first row), the FIRST sourced entity is written INTO that blank row in place
 * (keeping its position) and the rest are inserted. So a fresh table + source N
 * yields exactly N rows, none blank. Genuinely-new rows still honor the table's
 * dedupe policy. A bad row never sinks the batch.
 */
export async function insertSourcedRows(
  rows: Array<Record<string, unknown>>,
  ctx: { tableId: string; sourceId: string; actor?: string; dedupe?: DedupePolicy },
): Promise<SourcedRowsResult> {
  let created = 0;
  let merged = 0;
  let filled = 0;

  // Start appending past the current max position so sourced rows trail the grid.
  const [posRow] = await db
    .select({ maxPos: sql<number>`coalesce(max(${leads.position}), -1)::int` })
    .from(leads)
    .where(eq(leads.tableId, ctx.tableId));
  let nextPos = (posRow?.maxPos ?? -1) + 1;

  // Reuse the seeded blank row for the first genuinely-new sourced entity. The
  // policy decides whether a row dedupes into an existing one BEFORE we touch the
  // blank, so a dedupe match still wins (the blank is only for genuinely-new rows).
  const policy = ctx.dedupe ?? (await policyForTable(ctx.tableId));
  let blank = await findBlankLead(ctx.tableId);

  for (const row of rows) {
    try {
      const canonical = sourcedRowToCanonical(row);

      // Blank-fill path: a new row (no dedupe match) and a blank seed row exists.
      if (blank) {
        const match = await findPolicyMatch(canonical, ctx.tableId, policy);
        if (!match) {
          await fillBlankLead(blank, canonical, ctx.actor);
          blank = undefined; // only one blank row to reuse
          created++;
          filled++;
          continue;
        }
      }

      // Normal path: ingestLead applies the dedupe policy (merge or create).
      const { lead, created: isNew } = await ingestLead(canonical, {
        sourceId: ctx.sourceId,
        tableId: ctx.tableId,
        actor: ctx.actor,
        dedupe: ctx.dedupe,
      });
      if (isNew) {
        await db.update(leads).set({ position: nextPos++ }).where(eq(leads.id, lead.id));
        created++;
      } else {
        merged++;
      }
    } catch {
      continue; // one malformed row never sinks the batch
    }
  }
  return { created, merged, filled };
}

/** Count leads at a domain — used by the account view and dedupe assertions. */
export async function leadCountForAccount(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(eq(leads.accountId, accountId));
  return row?.n ?? 0;
}
