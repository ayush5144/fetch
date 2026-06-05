import { Hono } from 'hono';
import { pingDb } from '@fetch/db';

/**
 * GET /health — liveness + DB connectivity. Returns 200 with db: ok when
 * Postgres answers, 503 when it doesn't. This is what a load balancer or the
 * self-host bring-up script polls to know the stack is ready.
 */
export const healthRoutes = new Hono();

healthRoutes.get('/health', async (c) => {
  try {
    const ok = await pingDb();
    return c.json({ status: 'ok', db: ok ? 'ok' : 'down' }, ok ? 200 : 503);
  } catch (err) {
    return c.json({ status: 'error', db: 'down', error: String(err) }, 503);
  }
});
