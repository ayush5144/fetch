import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an inbound webhook's HMAC-SHA256 signature against the shared secret.
 * Constant-time comparison avoids timing leaks. When no secret is configured
 * for a provider we *reject* rather than silently accept — a webhook endpoint
 * must never trust an unsigned payload.
 */
export function verifySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Normalize common "sha256=..." prefixes.
  const provided = signature.replace(/^sha256=/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
