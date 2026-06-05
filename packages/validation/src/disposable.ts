/**
 * A compact set of common disposable / throwaway email domains. This is not
 * exhaustive — a production deploy can swap in a maintained list — but it
 * catches the obvious offenders so a mailinator address never slips through as
 * `valid`.
 */
export const DISPOSABLE_DOMAINS = new Set<string>([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'getnada.com',
  'trashmail.com',
  'fakeinbox.com',
  'sharklasers.com',
  'maildrop.cc',
  'dispostable.com',
]);

export function isDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}
