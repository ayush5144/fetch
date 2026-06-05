import type { MiddlewareHandler } from 'hono';

/**
 * A tiny in-memory fixed-window rate limiter. Enough to blunt abuse of the
 * public endpoints (webhooks, imports) in a single-instance self-host without
 * pulling in Redis — consistent with the no-extra-infra baseline. For a
 * multi-instance deploy, swap this for a shared store behind the same signature.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: { windowMs: number; max: number }): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const key =
      c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'local';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    } else {
      bucket.count += 1;
      if (bucket.count > opts.max) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        return c.json({ error: 'rate limit exceeded' }, 429, {
          'retry-after': String(retryAfter),
        });
      }
    }
    await next();
  };
}
