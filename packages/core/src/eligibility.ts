import type { Lead } from '@fetch/db';

/** Per-campaign send rules that gate which leads are eligible. */
export interface CampaignRules {
  /** Include `risky` leads (off by default — the gate is strict). */
  allowRisky?: boolean;
  /** Require human approval of the copy before sending (on by default). */
  requireApproved?: boolean;
}

/**
 * The send gate, as one pure predicate. A lead is eligible only if it clears
 * BOTH gates: validation (`valid`, or `risky` when opted in) AND, by policy,
 * approval. Already-sent leads are never re-sent. Keeping this here — instead of
 * inline in the launch route — makes the gate independently testable and the
 * single definition the route and worker both trust.
 */
export function isCampaignEligible(lead: Lead, rules: CampaignRules = {}): boolean {
  if (lead.sendStatus === 'sent') return false;

  const validationOk =
    lead.validationStatus === 'valid' ||
    (lead.validationStatus === 'risky' && (rules.allowRisky ?? false));
  if (!validationOk) return false;

  if ((rules.requireApproved ?? true) && lead.approvalStatus !== 'approved') return false;

  return true;
}
