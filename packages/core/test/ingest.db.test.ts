import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, accounts, auditLog, db, sources } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { ingestLead, leadCountForAccount } from '../src/dedupe';
import type { DedupePolicy } from '../src/dedupe';

/**
 * Phase 2 + Phase G — canonical model, ingestion, OPT-IN dedupe. These run
 * against a real Postgres (the `db` vitest project) because the behavior under
 * test — merge vs create, account sharing, audit rows — only exists at the
 * database boundary.
 *
 * Dedupe is now operator-chosen: the DEFAULT is `none` (always create). Tests
 * that want merge/accounts pass an explicit policy.
 */
const BY_EMAIL: DedupePolicy = { mode: 'columns', keys: ['email'] };
const BY_COMPANY: DedupePolicy = { mode: 'company' };

async function newSource() {
  const [s] = await db.insert(sources).values({ type: 'csv', raw: { test: true } }).returning();
  return s!.id;
}

const csvRow = (overrides: Partial<Record<string, string>> = {}) => ({
  first_name: 'Ava',
  last_name: 'Chen',
  email: 'ava@acme.com',
  company: 'Acme',
  title: 'VP Sales',
  ...overrides,
});

function canonicalFrom(row: Record<string, string>) {
  const csv = `${Object.keys(row).join(',')}\n${Object.values(row).join(',')}`;
  return new CsvNormalizer().normalize(csv)[0]!;
}

describe('ingestLead', () => {
  beforeEach(truncateAll);

  it('creates a new canonical lead and an account for its domain (company policy)', async () => {
    const sourceId = await newSource();
    const { lead, created } = await ingestLead(canonicalFrom(csvRow()), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_COMPANY,
    });

    expect(created).toBe(true);
    expect(lead.email).toBe('ava@acme.com');
    expect(lead.accountId).toBeTruthy();

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, lead.accountId!) });
    expect(account?.domain).toBe('acme.com');
  });

  it('dedupes on email (columns policy): re-importing the same person merges, never duplicates', async () => {
    const sourceId = await newSource();
    const first = await ingestLead(canonicalFrom(csvRow()), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });
    const second = await ingestLead(canonicalFrom(csvRow({ title: 'SVP Sales' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });

    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id); // same row

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(1);
  });

  it('default policy is none: re-importing the same person creates a duplicate', async () => {
    const sourceId = await newSource();
    // No `dedupe` and no table setting → default `none` → always create.
    const first = await ingestLead(canonicalFrom(csvRow()), { sourceId, tableId: DEFAULT_TABLE_ID });
    const second = await ingestLead(canonicalFrom(csvRow({ title: 'SVP Sales' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.lead.id).not.toBe(first.lead.id);

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(2);
  });

  it('none policy creates NO accounts row; columns policy creates NO accounts row', async () => {
    const sourceId = await newSource();
    await ingestLead(canonicalFrom(csvRow()), { sourceId, tableId: DEFAULT_TABLE_ID });
    await ingestLead(canonicalFrom(csvRow({ email: 'liam@acme.com' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });

    const accountRows = await db.query.accounts.findMany();
    expect(accountRows).toHaveLength(0);

    const all = await db.query.leads.findMany();
    expect(all.every((l) => l.accountId === null)).toBe(true);
  });

  it('company policy creates one accounts row per domain', async () => {
    const sourceId = await newSource();
    await ingestLead(canonicalFrom(csvRow({ email: 'ava@acme.com' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_COMPANY,
    });
    await ingestLead(canonicalFrom(csvRow({ first_name: 'Liam', email: 'liam@acme.com' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_COMPANY,
    });

    const accountRows = await db.query.accounts.findMany();
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]!.domain).toBe('acme.com');
  });

  it('merges only into empty fields and never clobbers existing data (columns policy)', async () => {
    const sourceId = await newSource();
    await ingestLead(canonicalFrom(csvRow({ title: 'VP Sales' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });
    // Second import has a different title; existing title must win.
    const { lead } = await ingestLead(canonicalFrom(csvRow({ title: 'Intern' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });
    expect(lead.title).toBe('VP Sales');
  });

  it('shares one account across two leads at the same company (company policy)', async () => {
    const sourceId = await newSource();
    const a = await ingestLead(canonicalFrom(csvRow({ email: 'ava@acme.com' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_COMPANY,
    });
    const b = await ingestLead(canonicalFrom(csvRow({ first_name: 'Liam', email: 'liam@acme.com' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_COMPANY,
    });

    expect(a.lead.accountId).toBe(b.lead.accountId);
    expect(await leadCountForAccount(a.lead.accountId!)).toBe(2);

    const accountRows = await db.query.accounts.findMany();
    expect(accountRows).toHaveLength(1);
  });

  it('reads the policy from the table settings when none is passed', async () => {
    const sourceId = await newSource();
    // Set the default table's policy to merge-by-email, then re-import twice
    // WITHOUT passing a policy — the table setting drives the merge.
    const { tables } = await import('@fetch/db');
    await db
      .insert(tables)
      .values({ id: DEFAULT_TABLE_ID, name: 'Leads', settings: { dedupe: BY_EMAIL } })
      .onConflictDoUpdate({ target: tables.id, set: { settings: { dedupe: BY_EMAIL } } });

    const first = await ingestLead(canonicalFrom(csvRow()), { sourceId, tableId: DEFAULT_TABLE_ID });
    const second = await ingestLead(canonicalFrom(csvRow({ phone: '555-1234' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
    });

    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
  });

  it('imports a no-email lead without crashing and flags it no_email', async () => {
    const sourceId = await newSource();
    const { lead, created } = await ingestLead(
      canonicalFrom({ first_name: 'Anon', company: 'Globex' } as Record<string, string>),
      { sourceId, tableId: DEFAULT_TABLE_ID },
    );
    expect(created).toBe(true);
    expect(lead.email).toBeNull();
    expect(lead.validationStatus).toBe('no_email');
  });

  it('writes an audit_log entry on create and on merge (columns policy)', async () => {
    const sourceId = await newSource();
    const { lead } = await ingestLead(canonicalFrom(csvRow()), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });
    await ingestLead(canonicalFrom(csvRow({ phone: '555-1234' })), {
      sourceId,
      tableId: DEFAULT_TABLE_ID,
      dedupe: BY_EMAIL,
    });

    const entries = await db.query.auditLog.findMany({ where: eq(auditLog.entityId, lead.id) });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
  });

  it('persists the raw payload on the source row', async () => {
    const sourceId = await newSource();
    const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
    expect(src?.raw).toMatchObject({ test: true });
  });
});
