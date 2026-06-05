import type { Lead } from '@fetch/db';

/**
 * A deliberately tiny, SAFE formula evaluator for `formula` columns. It does
 * NOT use eval — it supports a small set of operations over other columns, so
 * an operator can derive icp_score = size * 0.5 without us shipping an arbitrary
 * code-execution surface. Unknown expressions return null rather than throwing.
 *
 * Supported config shape:
 *   { kind: 'arithmetic', expr: 'company_size * 0.5 + 10' }
 *   { kind: 'concat', parts: ['{{first_name}}', ' @ ', '{{company_name}}'] }
 *   { kind: 'coalesce', fields: ['work_email', 'email'] }
 */
export interface FormulaConfig {
  kind: 'arithmetic' | 'concat' | 'coalesce';
  expr?: string;
  parts?: string[];
  fields?: string[];
  /** Columns this formula reads — used to recompute on dependency change. */
  dependsOn?: string[];
}

function scope(lead: Lead): Record<string, unknown> {
  const data = (lead.data as Record<string, unknown>) ?? {};
  return {
    ...data,
    first_name: lead.firstName,
    last_name: lead.lastName,
    email: lead.email,
    title: lead.title,
  };
}

export function evaluateFormula(config: FormulaConfig, lead: Lead): unknown {
  const vars = scope(lead);

  switch (config.kind) {
    case 'concat':
      return (config.parts ?? [])
        .map((p) => p.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(vars[k] ?? '')))
        .join('');

    case 'coalesce':
      for (const f of config.fields ?? []) {
        const v = vars[f];
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;

    case 'arithmetic':
      return evalArithmetic(config.expr ?? '', vars);

    default:
      return null;
  }
}

/**
 * Evaluate a restricted arithmetic expression over numeric variables. Tokenizes
 * to numbers / identifiers / operators only, then runs a shunting-yard-free
 * left-to-right pass with precedence. Anything unrecognized → null.
 */
function evalArithmetic(expr: string, vars: Record<string, unknown>): number | null {
  const tokens = expr.match(/(\d+\.?\d*|[a-zA-Z_]\w*|[-+*/()])/g);
  if (!tokens) return null;

  // Substitute identifiers with their numeric value; bail if non-numeric.
  const resolved: (number | string)[] = [];
  for (const t of tokens) {
    if (/^[a-zA-Z_]/.test(t)) {
      const n = Number(vars[t]);
      if (!Number.isFinite(n)) return null;
      resolved.push(n);
    } else if (/^\d/.test(t)) {
      resolved.push(Number(t));
    } else {
      resolved.push(t);
    }
  }

  try {
    return computeRPN(toRPN(resolved));
  } catch {
    return null;
  }
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

function toRPN(tokens: (number | string)[]): (number | string)[] {
  const out: (number | string)[] = [];
  const ops: string[] = [];
  for (const t of tokens) {
    if (typeof t === 'number') out.push(t);
    else if (t in PREC) {
      while (ops.length && ops[ops.length - 1]! in PREC && PREC[ops[ops.length - 1]!]! >= PREC[t]!) {
        out.push(ops.pop()!);
      }
      ops.push(t);
    } else if (t === '(') ops.push(t);
    else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()!);
      ops.pop();
    }
  }
  while (ops.length) out.push(ops.pop()!);
  return out;
}

function computeRPN(rpn: (number | string)[]): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (typeof t === 'number') stack.push(t);
    else {
      const b = stack.pop()!;
      const a = stack.pop()!;
      stack.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : a / b);
    }
  }
  return stack[0] ?? 0;
}
