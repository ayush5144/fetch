import { describe, expect, it } from 'vitest';
import type { Lead } from '@fetch/db';
import { evaluateFormula } from '../src/formula';

/**
 * Phase 4 — formula evaluator.
 *
 * `evaluateFormula` is a pure function, so these are straight unit tests —
 * no database, no network, no side effects. We exercise all four `kind` values
 * and a handful of edge-cases that protect against regressions in the
 * shunting-yard / concat / coalesce paths.
 */

// ── Fixture ────────────────────────────────────────────────────────────────

/** Minimal Lead fixture; formula uses firstName, lastName, email, title, + data. */
function makeLead(overrides: Partial<Lead> & { data?: Record<string, unknown> } = {}): Lead {
  return {
    id: 'lead-test',
    email: 'alice@acme.com',
    firstName: 'Alice',
    lastName: 'Smith',
    title: 'VP Sales',
    phone: null,
    linkedinUrl: null,
    accountId: null,
    sourceId: null,
    enrichmentStatus: 'pending',
    enrichmentConf: {},
    validationStatus: 'unchecked',
    validationDetail: {},
    subject: null,
    body: null,
    promptVersion: null,
    approvalStatus: 'draft',
    campaignId: null,
    provider: null,
    providerLeadId: null,
    sendStatus: 'none',
    sentAt: null,
    openedAt: null,
    clickedAt: null,
    repliedAt: null,
    bouncedAt: null,
    unsubscribedAt: null,
    data: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Lead;
}

// ── arithmetic ─────────────────────────────────────────────────────────────

describe('evaluateFormula — arithmetic', () => {
  it('evaluates a simple expression from lead.data (company_size * 0.5 + 10)', () => {
    const lead = makeLead({ data: { company_size: 200 } });
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'company_size * 0.5 + 10' }, lead);
    // 200 * 0.5 = 100; 100 + 10 = 110
    expect(result).toBe(110);
  });

  it('respects operator precedence (* before +)', () => {
    const lead = makeLead({ data: { a: 3, b: 4, c: 2 } });
    // a + b * c  →  3 + (4*2) = 11, NOT (3+4)*2 = 14
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'a + b * c' }, lead);
    expect(result).toBe(11);
  });

  it('respects explicit parentheses overriding default precedence', () => {
    const lead = makeLead({ data: { a: 3, b: 4, c: 2 } });
    // (a + b) * c  →  (3+4)*2 = 14
    const result = evaluateFormula({ kind: 'arithmetic', expr: '(a + b) * c' }, lead);
    expect(result).toBe(14);
  });

  it('returns null when a variable is non-numeric', () => {
    // A string value cannot be part of arithmetic; returning null keeps the
    // engine from writing garbage to a numeric column.
    const lead = makeLead({ data: { company_size: 'large' } });
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'company_size * 0.5' }, lead);
    expect(result).toBeNull();
  });

  it('returns null for an undefined variable', () => {
    const lead = makeLead({ data: {} });
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'missing_var + 1' }, lead);
    expect(result).toBeNull();
  });

  it('handles division correctly', () => {
    const lead = makeLead({ data: { revenue: 1000, headcount: 5 } });
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'revenue / headcount' }, lead);
    expect(result).toBe(200);
  });

  it('handles subtraction correctly', () => {
    const lead = makeLead({ data: { total: 100, discount: 15 } });
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'total - discount' }, lead);
    expect(result).toBe(85);
  });

  it('can reference system fields (title is non-numeric → null)', () => {
    // `title` is a system field on the lead, not in data. Since it's a string
    // the arithmetic evaluator should return null rather than NaN.
    const lead = makeLead();
    const result = evaluateFormula({ kind: 'arithmetic', expr: 'title + 1' }, lead);
    expect(result).toBeNull();
  });
});

// ── concat ─────────────────────────────────────────────────────────────────

describe('evaluateFormula — concat', () => {
  it('joins parts with {{var}} substitution from system fields', () => {
    const lead = makeLead({ firstName: 'Alice', email: 'alice@acme.com' });
    const result = evaluateFormula(
      { kind: 'concat', parts: ['{{first_name}}', ' @ ', '{{email}}'] },
      lead
    );
    expect(result).toBe('Alice @ alice@acme.com');
  });

  it('substitutes from lead.data (user columns)', () => {
    const lead = makeLead({ data: { company_name: 'Acme Corp' } });
    const result = evaluateFormula(
      { kind: 'concat', parts: ['{{first_name}}', ' works at ', '{{company_name}}'] },
      lead
    );
    expect(result).toBe('Alice works at Acme Corp');
  });

  it('replaces missing vars with an empty string (no undefined in output)', () => {
    const lead = makeLead({ data: {} });
    const result = evaluateFormula(
      { kind: 'concat', parts: ['Hello ', '{{nonexistent}}', '!'] },
      lead
    );
    expect(result).toBe('Hello !');
  });

  it('handles literal text parts without placeholders', () => {
    const lead = makeLead();
    const result = evaluateFormula({ kind: 'concat', parts: ['fixed', '-', 'text'] }, lead);
    expect(result).toBe('fixed-text');
  });

  it('returns an empty string for an empty parts array', () => {
    const lead = makeLead();
    const result = evaluateFormula({ kind: 'concat', parts: [] }, lead);
    expect(result).toBe('');
  });

  it('tolerates spaces around the variable name in {{  var  }}', () => {
    const lead = makeLead({ firstName: 'Alice' });
    const result = evaluateFormula(
      { kind: 'concat', parts: ['Hello {{ first_name }}!'] },
      lead
    );
    expect(result).toBe('Hello Alice!');
  });
});

// ── coalesce ───────────────────────────────────────────────────────────────

describe('evaluateFormula — coalesce', () => {
  it('returns the first non-empty field in the list', () => {
    const lead = makeLead({ data: { work_email: '', personal_email: 'alice@personal.dev' } });
    // work_email is empty-string → skip; personal_email has a value → return it
    const result = evaluateFormula(
      { kind: 'coalesce', fields: ['work_email', 'personal_email', 'email'] },
      lead
    );
    expect(result).toBe('alice@personal.dev');
  });

  it('falls through to the system-field email when data fields are missing', () => {
    const lead = makeLead({ email: 'alice@acme.com', data: {} });
    const result = evaluateFormula({ kind: 'coalesce', fields: ['work_email', 'email'] }, lead);
    expect(result).toBe('alice@acme.com');
  });

  it('returns null when every field is empty or missing', () => {
    const lead = makeLead({ email: null as unknown as string, data: {} });
    const result = evaluateFormula({ kind: 'coalesce', fields: ['work_email', 'email'] }, lead);
    expect(result).toBeNull();
  });

  it('returns null for an empty fields array', () => {
    const lead = makeLead();
    const result = evaluateFormula({ kind: 'coalesce', fields: [] }, lead);
    expect(result).toBeNull();
  });

  it('skips undefined values but picks up the next truthy one', () => {
    const lead = makeLead({ data: { field_a: undefined, field_b: 'found' } });
    const result = evaluateFormula({ kind: 'coalesce', fields: ['field_a', 'field_b'] }, lead);
    expect(result).toBe('found');
  });
});

// ── unknown kind ───────────────────────────────────────────────────────────

describe('evaluateFormula — unknown kind', () => {
  it('returns null for an unrecognised formula kind', () => {
    const lead = makeLead();
    // Casting through `any` to simulate an unsupported kind coming from the DB.
    const result = evaluateFormula({ kind: 'regex' as any }, lead);
    expect(result).toBeNull();
  });
});
