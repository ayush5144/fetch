import { describe, expect, it } from 'vitest';
import { validateCellValue, valueTypeOf } from '../src/validate';

/**
 * Typed-cell validation is a pure function — straight unit tests, no DB. We
 * cover every value type's accept/reject path plus coercion (string→number,
 * "true"→true, bare domain→URL) and the always-allowed empty-clear case.
 */

describe('valueTypeOf', () => {
  it('defaults to text when unset or unknown', () => {
    expect(valueTypeOf(undefined)).toBe('text');
    expect(valueTypeOf({})).toBe('text');
    expect(valueTypeOf({ valueType: 'nonsense' })).toBe('text');
  });
  it('reads a known value type', () => {
    expect(valueTypeOf({ valueType: 'email' })).toBe('email');
  });
});

describe('validateCellValue', () => {
  it('always allows clearing a cell, for any type', () => {
    for (const v of ['', null, undefined]) {
      expect(validateCellValue('number', v).ok).toBe(true);
      expect(validateCellValue('email', v).ok).toBe(true);
    }
  });

  it('email accepts valid, rejects garbage', () => {
    expect(validateCellValue('email', 'ava@acme.com')).toMatchObject({ ok: true });
    expect(validateCellValue('email', 'not-an-email').ok).toBe(false);
    expect(validateCellValue('email', 'a@b').ok).toBe(false);
  });

  it('number coerces strings and rejects non-numbers', () => {
    expect(validateCellValue('number', '42')).toMatchObject({ ok: true, value: 42 });
    expect(validateCellValue('number', 7)).toMatchObject({ ok: true, value: 7 });
    expect(validateCellValue('number', 'abc').ok).toBe(false);
    expect(validateCellValue('number', true).ok).toBe(false);
  });

  it('url accepts bare domains and full URLs, rejects junk', () => {
    expect(validateCellValue('url', 'https://acme.com')).toMatchObject({ ok: true });
    expect(validateCellValue('url', 'acme.com')).toMatchObject({ ok: true });
    expect(validateCellValue('url', 'not a url').ok).toBe(false);
  });

  it('date accepts parseable values and stores ISO', () => {
    const r = validateCellValue('date', '2026-06-05');
    expect(r.ok).toBe(true);
    expect(String(r.value)).toContain('2026-06-05');
    expect(validateCellValue('date', 'someday').ok).toBe(false);
  });

  it('checkbox coerces "true"/"false" and rejects others', () => {
    expect(validateCellValue('checkbox', true)).toMatchObject({ ok: true, value: true });
    expect(validateCellValue('checkbox', 'false')).toMatchObject({ ok: true, value: false });
    expect(validateCellValue('checkbox', 'maybe').ok).toBe(false);
  });

  it('select enforces options when provided', () => {
    const cfg = { options: ['a', 'b'] };
    expect(validateCellValue('select', 'a', cfg)).toMatchObject({ ok: true });
    expect(validateCellValue('select', 'z', cfg).ok).toBe(false);
    // No options → any value allowed.
    expect(validateCellValue('select', 'z', {}).ok).toBe(true);
  });

  it('text accepts anything non-empty', () => {
    expect(validateCellValue('text', 'whatever')).toMatchObject({ ok: true });
  });
});
