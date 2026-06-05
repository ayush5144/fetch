import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { columns, db, leads, sources } from '@fetch/db';
import { truncateAll } from '@fetch/db/testing';
import { CsvNormalizer } from '@fetch/connectors';
import { ingestLead } from '@fetch/core';
import { isCellEmpty, planRun, runFormulaColumn, writeCell } from '../src';

/**
 * Phase 4 — dynamic column engine. Proves cell I/O with provenance, the
 * run-only-if-empty guard, formula recompute, and that deleting a column
 * definition never corrupts the values already in leads.data.
 */
async function makeLead(email: string, data: Record<string, string> = {}): Promise<string> {
  const [src] = await db.insert(sources).values({ type: 'csv', raw: {} }).returning();
  const headers = ['email', ...Object.keys(data)];
  const values = [email, ...Object.values(data)];
  const csv = `${headers.join(',')}\n${values.join(',')}`;
  const { lead } = await ingestLead(new CsvNormalizer().normalize(csv)[0]!, { sourceId: src!.id });
  return lead.id;
}

describe('cell I/O + provenance', () => {
  beforeEach(truncateAll);

  it('writes a value into leads.data and its provenance into enrichmentConf', async () => {
    const id = await makeLead('ava@acme.com');
    await writeCell(id, 'company_size', {
      value: 240,
      confidence: 0.9,
      source: 'https://acme.com/about',
      provider: 'apollo',
    });

    const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect((lead!.data as any).company_size).toBe(240);
    const prov = (lead!.enrichmentConf as any).company_size;
    expect(prov.confidence).toBe(0.9);
    expect(prov.source).toBe('https://acme.com/about');
    expect(prov.provider).toBe('apollo');
  });

  it('only writes into data — a system column like email is untouched', async () => {
    const id = await makeLead('ava@acme.com');
    await writeCell(id, 'company_size', { value: 10, confidence: 1, source: null });
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(lead!.email).toBe('ava@acme.com'); // system column intact
    expect((lead!.data as any).company_size).toBe(10);
  });

  it('isCellEmpty reflects fill state', async () => {
    const id = await makeLead('ava@acme.com');
    let lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(isCellEmpty(lead!, 'x')).toBe(true);
    await writeCell(id, 'x', { value: 'set', confidence: 1, source: null });
    lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect(isCellEmpty(lead!, 'x')).toBe(false);
  });
});

describe('run-only-if-empty', () => {
  beforeEach(truncateAll);

  it('plans a run over only the empty cells, unless forced', async () => {
    await db.insert(columns).values({ key: 'note', label: 'Note', type: 'manual', config: {} });
    const a = await makeLead('a@x.com');
    const b = await makeLead('b@x.com');
    await writeCell(a, 'note', { value: 'already', confidence: 1, source: null });

    const plan = await planRun('note', [a, b]);
    expect(plan!.toRun.map((l) => l.id)).toEqual([b]); // only the empty one
    expect(plan!.skipped).toBe(1);

    const forced = await planRun('note', [a, b], { force: true });
    expect(forced!.toRun).toHaveLength(2); // force ignores the guard
  });
});

describe('formula columns', () => {
  beforeEach(truncateAll);

  it('computes and recomputes a formula from other columns', async () => {
    await db.insert(columns).values({
      key: 'score',
      label: 'Score',
      type: 'formula',
      config: { kind: 'arithmetic', expr: 'company_size * 2' },
    });
    const id = await makeLead('a@x.com');
    await writeCell(id, 'company_size', { value: 50, confidence: 1, source: null });

    expect(await runFormulaColumn('score', [id])).toBe(1);
    let lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect((lead!.data as any).score).toBe(100);

    // Change the input → recompute yields a new value.
    await writeCell(id, 'company_size', { value: 75, confidence: 1, source: null });
    await runFormulaColumn('score', [id]);
    lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect((lead!.data as any).score).toBe(150);
  });
});

describe('column deletion safety', () => {
  beforeEach(truncateAll);

  it('removing a column definition leaves existing data keys intact', async () => {
    const [col] = await db
      .insert(columns)
      .values({ key: 'temp', label: 'Temp', type: 'manual', config: {} })
      .returning();
    const id = await makeLead('a@x.com');
    await writeCell(id, 'temp', { value: 'keep me', confidence: 1, source: null });
    await writeCell(id, 'other', { value: 'also keep', confidence: 1, source: null });

    await db.delete(columns).where(eq(columns.id, col!.id));

    const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    expect((lead!.data as any).temp).toBe('keep me'); // value survives def deletion
    expect((lead!.data as any).other).toBe('also keep');
  });
});
