import { accounts, db, leads } from '@fetch/db';
import type { Account, Lead } from '@fetch/db';
import { and, eq, sql } from 'drizzle-orm';
import { audit, diffOf } from './audit';
import type { CanonicalLead } from './types';

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
 * Ingest one canonical lead with dedupe on email. On a match we MERGE
 * (fill empty system fields, shallow-merge user `data`) rather than duplicate;
 * with no match we create. Re-importing the same CSV therefore yields zero
 * duplicate leads. Every path writes an audit_log entry.
 *
 * Returns the persisted lead and whether it was newly created — the caller uses
 * `created` plus what's missing to decide which jobs to enqueue.
 */
export async function ingestLead(
  canonical: CanonicalLead,
  ctx: { sourceId: string; tableId: string; actor?: string },
): Promise<{ lead: Lead; created: boolean }> {
  const account = await findOrCreateAccount(canonical);
  const email = canonical.email?.trim().toLowerCase() || null;

  // Dedupe is scoped to the table — a lead with the same email in another table
  // is a separate row. (Phase G makes the dedupe key configurable per table.)
  const existing = email
    ? await db.query.leads.findFirst({
        where: and(eq(leads.email, email), eq(leads.tableId, ctx.tableId)),
      })
    : undefined;

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
