import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_TABLE_ID, auditLog, db, leads } from '@fetch/db';
import type { NewLead } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { dedupeExistingRows } from '../src/dedupe';

/**
 * Phase G — dedupe EXISTING rows in a table by column(s) (the Clay-style
 * "Dedupe by this column" action). Runs against a real Postgres (the `db`
 * vitest project) because the behavior — merge into the oldest keeper, delete
 * the dupes, audit rows, idempotency — only exists at the database boundary.
 */

/** Insert a lead straight into the default table with an explicit createdAt. */
async function insertLead(overrides: Partial<NewLead> & { createdAt?: Date }) {
  const { createdAt, ...rest } = overrides;
  const [row] = await db
    .insert(leads)
    .values({
      tableId: DEFAULT_TABLE_ID,
      ...rest,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning();
  return row!;
}

const T0 = new Date('2024-01-01T00:00:00Z');
const T1 = new Date('2024-02-01T00:00:00Z');
const T2 = new Date('2024-03-01T00:00:00Z');

describe('dedupeExistingRows', () => {
  beforeEach(truncateAll);

  it('merges two rows with the same email to one, keeping the oldest', async () => {
    // Oldest row is missing phone/title; the newer dupe has them.
    const keeper = await insertLead({
      email: 'ava@acme.com',
      firstName: 'Ava',
      title: 'VP Sales',
      createdAt: T0,
    });
    const dupe = await insertLead({
      email: 'AVA@acme.com', // case/space-insensitive grouping
      firstName: 'Ava',
      phone: '555-1234',
      title: 'Intern', // keeper already has a title → must NOT be clobbered
      createdAt: T1,
    });

    const res = await dedupeExistingRows(DEFAULT_TABLE_ID, ['email']);
    expect(res).toMatchObject({ groups: 1, merged: 1, kept: 1, rows: 1 });

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(1);

    const survivor = all[0]!;
    expect(survivor.id).toBe(keeper.id); // oldest kept
    expect(survivor.phone).toBe('555-1234'); // empty keeper field filled from dupe
    expect(survivor.title).toBe('VP Sales'); // non-empty keeper field preserved

    // The dupe row is gone.
    const gone = await db.query.leads.findFirst({ where: eq(leads.id, dupe.id) });
    expect(gone).toBeUndefined();
  });

  it('leaves rows with a null/empty key value untouched', async () => {
    await insertLead({ email: null, firstName: 'NoEmail1', createdAt: T0 });
    await insertLead({ email: null, firstName: 'NoEmail2', createdAt: T1 });
    await insertLead({ email: '   ', firstName: 'Blank', createdAt: T2 });

    const res = await dedupeExistingRows(DEFAULT_TABLE_ID, ['email']);
    expect(res).toMatchObject({ groups: 0, merged: 0, kept: 0, rows: 0 });

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(3); // nothing merged away
  });

  it('dryRun mutates nothing but returns the correct counts', async () => {
    await insertLead({ email: 'dup@acme.com', createdAt: T0 });
    await insertLead({ email: 'dup@acme.com', createdAt: T1 });
    await insertLead({ email: 'dup@acme.com', createdAt: T2 });
    await insertLead({ email: 'solo@acme.com', createdAt: T0 });

    const res = await dedupeExistingRows(DEFAULT_TABLE_ID, ['email'], { dryRun: true });
    expect(res).toMatchObject({ groups: 1, merged: 2, kept: 1, rows: 2 });

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(4); // untouched
    const audits = await db.query.auditLog.findMany();
    expect(audits).toHaveLength(0); // no audit on a dry run
  });

  it('is idempotent: a second consecutive run merges 0', async () => {
    await insertLead({ email: 'dup@acme.com', firstName: 'A', createdAt: T0 });
    await insertLead({ email: 'dup@acme.com', phone: '555-9999', createdAt: T1 });

    const first = await dedupeExistingRows(DEFAULT_TABLE_ID, ['email']);
    expect(first.merged).toBe(1);

    const second = await dedupeExistingRows(DEFAULT_TABLE_ID, ['email']);
    expect(second).toMatchObject({ groups: 0, merged: 0, kept: 0, rows: 0 });

    expect(await db.query.leads.findMany()).toHaveLength(1);
  });

  it('writes an update audit on the keeper and a delete audit on each removed row', async () => {
    const keeper = await insertLead({ email: 'dup@acme.com', firstName: 'A', createdAt: T0 });
    const dupe = await insertLead({ email: 'dup@acme.com', phone: '555-1234', createdAt: T1 });

    await dedupeExistingRows(DEFAULT_TABLE_ID, ['email']);

    const keeperAudits = await db.query.auditLog.findMany({
      where: and(eq(auditLog.entityId, keeper.id), eq(auditLog.action, 'update')),
    });
    expect(keeperAudits).toHaveLength(1); // keeper absorbed the phone

    const deleteAudits = await db.query.auditLog.findMany({
      where: and(eq(auditLog.entityId, dupe.id), eq(auditLog.action, 'delete')),
    });
    expect(deleteAudits).toHaveLength(1);
    expect(deleteAudits[0]!.diff).toMatchObject({ mergedInto: keeper.id });
  });

  it('groups by multiple keys (company + title)', async () => {
    // company lives in data; title is a system field.
    await insertLead({ title: 'CEO', data: { company: 'Acme' }, createdAt: T0 });
    await insertLead({ title: 'CEO', data: { company: 'Acme' }, createdAt: T1 }); // dup of above
    await insertLead({ title: 'CEO', data: { company: 'Globex' }, createdAt: T0 }); // different company
    await insertLead({ title: 'CTO', data: { company: 'Acme' }, createdAt: T0 }); // different title

    const res = await dedupeExistingRows(DEFAULT_TABLE_ID, ['company', 'title']);
    expect(res).toMatchObject({ groups: 1, merged: 1, kept: 1, rows: 1 });

    const all = await db.query.leads.findMany();
    expect(all).toHaveLength(3); // only the one (Acme, CEO) pair collapsed
  });
});
