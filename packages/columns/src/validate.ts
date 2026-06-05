/**
 * Value-type validation for typed cells. A column carries a `config.valueType`
 * (text | email | url | number | date | select | checkbox, default text) that is
 * ORTHOGONAL to its fill method (`type`: dogi | formula | manual). When a human
 * inline-edits a cell, the value must satisfy the column's value type before it
 * persists — an Email column rejects `not-an-email`, a Number column stores a
 * number. This lives in the engine package so both the API and any worker path
 * validate the same way.
 */

export const VALUE_TYPES = [
  'text',
  'email',
  'url',
  'number',
  'date',
  'select',
  'checkbox',
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Read the value type off a column's config, defaulting to free text. */
export function valueTypeOf(config: unknown): ValueType {
  const vt = (config as { valueType?: unknown } | null | undefined)?.valueType;
  return typeof vt === 'string' && (VALUE_TYPES as readonly string[]).includes(vt)
    ? (vt as ValueType)
    : 'text';
}

export interface ValidationResult {
  ok: boolean;
  /** The coerced value to persist (e.g. a number, a boolean) when ok. */
  value?: unknown;
  /** A human-readable reason when not ok. */
  error?: string;
}

// A pragmatic email shape — one @, a dot in the domain, no spaces. We aren't
// doing deliverability here (that's the validate job); just rejecting garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate (and lightly coerce) a value against a value type. Empty values are
 * always allowed — clearing a cell is valid for every type. `select`'s allowed
 * set lives in `config.options` (array of strings) when present.
 */
export function validateCellValue(
  valueType: ValueType,
  value: unknown,
  config?: unknown,
): ValidationResult {
  // Clearing a cell is always permitted, regardless of type.
  if (value === null || value === undefined || value === '') {
    return { ok: true, value };
  }

  switch (valueType) {
    case 'email': {
      if (typeof value !== 'string' || !EMAIL_RE.test(value.trim())) {
        return { ok: false, error: 'must be a valid email address' };
      }
      return { ok: true, value: value.trim() };
    }
    case 'url': {
      const s = typeof value === 'string' ? value.trim() : '';
      if (!s) return { ok: false, error: 'must be a valid URL' };
      // Accept bare domains by assuming https when no scheme is present.
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
      try {
        const u = new URL(candidate);
        if (!u.hostname.includes('.')) return { ok: false, error: 'must be a valid URL' };
      } catch {
        return { ok: false, error: 'must be a valid URL' };
      }
      return { ok: true, value: s };
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(n) || !Number.isFinite(n)) {
        return { ok: false, error: 'must be a number' };
      }
      return { ok: true, value: n };
    }
    case 'date': {
      // Accept ISO-ish strings and epoch numbers; store as an ISO date string.
      const d = value instanceof Date ? value : new Date(value as string | number);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, error: 'must be a valid date' };
      }
      return { ok: true, value: d.toISOString() };
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
      return { ok: false, error: 'must be true or false' };
    }
    case 'select': {
      const options = (config as { options?: unknown } | undefined)?.options;
      if (Array.isArray(options) && options.length > 0) {
        if (!options.includes(value)) {
          return { ok: false, error: `must be one of: ${options.join(', ')}` };
        }
      }
      return { ok: true, value };
    }
    case 'text':
    default:
      return { ok: true, value };
  }
}
