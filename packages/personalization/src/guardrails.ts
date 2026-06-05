/**
 * Guardrails — the quality gate on generated copy. A draft must pass these
 * before it can move to `ready`; a failure flags the lead for human review
 * rather than letting weak or risky copy auto-approve.
 */
export interface Guardrails {
  maxLength?: number; // max body length in characters
  requiredVars?: string[]; // variables that must have resolved
  bannedClaims?: string[]; // phrases that must not appear (case-insensitive)
}

export interface Draft {
  subject: string;
  body: string;
}

export interface GuardrailResult {
  pass: boolean;
  failures: string[];
}

export function checkGuardrails(
  draft: Draft,
  guardrails: Guardrails,
  missingVars: string[] = [],
): GuardrailResult {
  const failures: string[] = [];

  if (!draft.subject.trim()) failures.push('empty subject');
  if (!draft.body.trim()) failures.push('empty body');

  if (guardrails.maxLength && draft.body.length > guardrails.maxLength) {
    failures.push(`body exceeds ${guardrails.maxLength} chars (${draft.body.length})`);
  }

  const required = guardrails.requiredVars ?? [];
  const unresolved = required.filter((v) => missingVars.includes(v));
  if (unresolved.length) failures.push(`missing required vars: ${unresolved.join(', ')}`);

  const haystack = `${draft.subject}\n${draft.body}`.toLowerCase();
  for (const claim of guardrails.bannedClaims ?? []) {
    if (haystack.includes(claim.toLowerCase())) failures.push(`banned claim: "${claim}"`);
  }

  return { pass: failures.length === 0, failures };
}
