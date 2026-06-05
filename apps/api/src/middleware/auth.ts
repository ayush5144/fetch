import type { MiddlewareHandler } from 'hono';
import { getEnv } from '@fetch/core';

/**
 * Optional bearer-token auth. Self-host is single-tenant first, so when
 * FETCH_API_TOKEN is unset the API is open and this is a no-op. When the token
 * IS set, every data route requires `Authorization: Bearer <token>`.
 *
 * Two paths are always exempt:
 *  - `/health` — load balancers and the bring-up script must reach it unauthed.
 *  - `/webhooks/*` — those authenticate by HMAC signature, not a bearer token.
 */
export function auth(): MiddlewareHandler {
  return async (c, next) => {
    const token = getEnv().FETCH_API_TOKEN;
    if (!token) return next(); // open by default

    const path = c.req.path;
    if (path === '/health' || path.startsWith('/webhooks/')) return next();

    const header = c.req.header('authorization') ?? '';
    const provided = header.replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
