/**
 * @fetch/validation — syntax · MX · SMTP (Reacher) · disposable · catch-all →
 * a status that GATES sending. This is the layer that stops Fetch from becoming
 * a send-anything machine.
 */
export * from './validate';
export * from './disposable';

import type { ValidationStatus } from '@fetch/db';

/** Statuses eligible for a campaign. `risky` only when the operator opts in. */
export function isSendable(status: ValidationStatus, allowRisky = false): boolean {
  if (status === 'valid') return true;
  if (status === 'risky' && allowRisky) return true;
  return false;
}
