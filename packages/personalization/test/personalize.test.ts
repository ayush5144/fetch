import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 7 — personalization (bind + guardrails). Pure-function tests: no LLM,
 * no database, no network. generate.ts is intentionally excluded because it
 * calls the LLM; those paths belong in an integration test with a mock model.
 *
 * @fetch/db is mocked to prevent its client.ts from eagerly opening a Postgres
 * pool. Only `import type { Lead }` is needed here, which TypeScript erases,
 * so the mock body can be empty.
 *
 * Tests map to two checklist lines:
 *  - "variable binding from lead, account, and data"
 *  - "guardrail checks flag failures for review"
 */

// Prevent the Postgres pool from being created at import time.
vi.mock('@fetch/db', () => ({}));

import { bindTemplate, buildVariables, checkGuardrails } from '../src/index';
import type { Lead } from '@fetch/db';

// ── Minimal Lead factory ─────────────────────────────────────────────────────
// `Lead` is the full Drizzle row type; we only need the fields used by bind.ts.
function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'test-id',
    accountId: null,
    sourceId: null,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@babbage.io',
    phone: null,
    title: 'Engineer',
    linkedinUrl: null,
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
  } as Lead;
}

// ── buildVariables ────────────────────────────────────────────────────────────

describe('buildVariables', () => {
  it('exposes system fields as string variables', () => {
    const vars = buildVariables(makeLead());
    expect(vars.first_name).toBe('Ada');
    expect(vars.last_name).toBe('Lovelace');
    expect(vars.title).toBe('Engineer');
    expect(vars.email).toBe('ada@babbage.io');
  });

  it('derives company_domain from the email', () => {
    const vars = buildVariables(makeLead({ email: 'ada@babbage.io' }));
    expect(vars.company_domain).toBe('babbage.io');
  });

  it('builds full_name from first + last', () => {
    const vars = buildVariables(makeLead({ firstName: 'Ada', lastName: 'Lovelace' }));
    expect(vars.full_name).toBe('Ada Lovelace');
  });

  it('exposes every user data key as a string variable', () => {
    const lead = makeLead({
      data: { recent_signal: 'raised Series A', headcount: 42 },
    });
    const vars = buildVariables(lead);
    expect(vars.recent_signal).toBe('raised Series A');
    // Numbers are coerced to string.
    expect(vars.headcount).toBe('42');
  });

  it('user data keys override nothing — they sit alongside system fields', () => {
    const lead = makeLead({ data: { custom_note: 'hello' } });
    const vars = buildVariables(lead);
    // System fields still present.
    expect(vars.first_name).toBe('Ada');
    expect(vars.custom_note).toBe('hello');
  });

  it('omits data keys whose values are null or undefined', () => {
    const lead = makeLead({ data: { nullish: null, present: 'ok' } });
    const vars = buildVariables(lead);
    expect('nullish' in vars).toBe(false);
    expect(vars.present).toBe('ok');
  });

  it('falls back to empty string when system fields are null', () => {
    const lead = makeLead({ firstName: null, lastName: null, title: null });
    const vars = buildVariables(lead);
    expect(vars.first_name).toBe('');
    expect(vars.last_name).toBe('');
    expect(vars.title).toBe('');
  });
});

// ── bindTemplate ──────────────────────────────────────────────────────────────

describe('bindTemplate', () => {
  it('replaces {{first_name}} with the resolved value', () => {
    const { text } = bindTemplate('Hi {{first_name}},', { first_name: 'Ada' });
    expect(text).toBe('Hi Ada,');
  });

  it('replaces multiple different tokens in one pass', () => {
    const { text } = bindTemplate('{{first_name}} works at {{company_domain}}.', {
      first_name: 'Ada',
      company_domain: 'babbage.io',
    });
    expect(text).toBe('Ada works at babbage.io.');
  });

  it('reports unresolved vars in missing[]', () => {
    const { text, missing } = bindTemplate('Hi {{first_name}}, see {{recent_signal}}!', {
      first_name: 'Ada',
    });
    expect(text).toBe('Hi Ada, see !');
    expect(missing).toContain('recent_signal');
    expect(missing).not.toContain('first_name');
  });

  it('deduplicates missing vars when the same token appears multiple times', () => {
    const { missing } = bindTemplate('{{x}} and {{x}} again', {});
    expect(missing).toEqual(['x']);
  });

  it('returns empty missing[] when all vars resolve', () => {
    const { missing } = bindTemplate('{{a}} {{b}}', { a: '1', b: '2' });
    expect(missing).toHaveLength(0);
  });

  it('treats a var whose value is an empty string as missing', () => {
    // An empty-string value is indistinguishable from "not enriched yet".
    const { missing } = bindTemplate('{{empty_var}}', { empty_var: '' });
    expect(missing).toContain('empty_var');
  });
});

// ── checkGuardrails ───────────────────────────────────────────────────────────

describe('checkGuardrails', () => {
  const cleanDraft = { subject: 'Quick question', body: 'Hi Ada, wanted to connect.' };
  const emptyGuardrails = {};

  it('passes a clean draft with no guardrails', () => {
    const result = checkGuardrails(cleanDraft, emptyGuardrails);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('flags an empty subject', () => {
    const result = checkGuardrails({ subject: '   ', body: 'body text' }, emptyGuardrails);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain('empty subject');
  });

  it('flags an empty body', () => {
    const result = checkGuardrails({ subject: 'Subject', body: '' }, emptyGuardrails);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain('empty body');
  });

  it('flags a body that exceeds maxLength', () => {
    const longBody = 'x'.repeat(501);
    const result = checkGuardrails({ subject: 'S', body: longBody }, { maxLength: 500 });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.startsWith('body exceeds 500 chars'))).toBe(true);
  });

  it('passes a body exactly at maxLength', () => {
    const body = 'x'.repeat(500);
    const result = checkGuardrails({ subject: 'S', body }, { maxLength: 500 });
    expect(result.pass).toBe(true);
  });

  it('flags missing required vars that were not resolved', () => {
    const result = checkGuardrails(cleanDraft, { requiredVars: ['recent_signal', 'first_name'] }, [
      'recent_signal',
    ]);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes('recent_signal'))).toBe(true);
    // first_name was resolved (not in missingVars), so it should NOT appear.
    expect(result.failures.some((f) => f.includes('first_name'))).toBe(false);
  });

  it('does not flag required vars that were resolved', () => {
    const result = checkGuardrails(cleanDraft, { requiredVars: ['first_name'] }, []);
    expect(result.pass).toBe(true);
  });

  it('flags banned claims (case-insensitive)', () => {
    const draft = { subject: 'Best offer', body: 'We Guarantee 10x ROI.' };
    const result = checkGuardrails(draft, { bannedClaims: ['guarantee'] });
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes('"guarantee"'))).toBe(true);
  });

  it('flags banned claims that appear in the subject', () => {
    const draft = { subject: 'Guaranteed Results', body: 'No claims here.' };
    const result = checkGuardrails(draft, { bannedClaims: ['guaranteed'] });
    expect(result.pass).toBe(false);
  });

  it('passes when banned claims are absent', () => {
    const draft = { subject: 'Hello', body: 'Honest message.' };
    const result = checkGuardrails(draft, { bannedClaims: ['guarantee', 'risk-free'] });
    expect(result.pass).toBe(true);
  });

  it('accumulates multiple failures in the failures array', () => {
    const result = checkGuardrails(
      { subject: '', body: '' },
      { requiredVars: ['first_name'], bannedClaims: [] },
      ['first_name'],
    );
    expect(result.failures).toContain('empty subject');
    expect(result.failures).toContain('empty body');
    expect(result.failures.some((f) => f.includes('first_name'))).toBe(true);
  });
});
