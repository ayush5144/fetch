import { Hono } from 'hono';
import { enqueue, getEnv } from '@fetch/core';
import { verifySignature } from '../middleware/webhookVerify';

/**
 * /webhooks/{provider} — inbound event intake. The contract here is strict and
 * deliberate:
 *   1. verify the signature (reject forged/unsigned payloads);
 *   2. ACK 200 immediately, then process asynchronously via an `event` job —
 *      providers retry only a few times and time out fast, so the endpoint must
 *      never block on processing.
 * Normalization, idempotency, and lead-matching happen in the worker's event
 * handler, keeping this endpoint as fast and dumb as the rest of the API.
 */
export const webhooksRoutes = new Hono();

async function handle(provider: 'instantly' | 'smartlead', c: any) {
  const env = getEnv();
  const secret =
    provider === 'instantly' ? env.INSTANTLY_WEBHOOK_SECRET : env.SMARTLEAD_WEBHOOK_SECRET;

  // Read the raw body so the signature is computed over exactly what was sent.
  const raw = await c.req.text();
  const signature =
    c.req.header('x-webhook-signature') ?? c.req.header('x-signature') ?? c.req.header('signature');

  if (!verifySignature(raw, signature, secret)) {
    return c.json({ error: 'invalid signature' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  // ACK fast: hand the payload to a worker and return immediately.
  await enqueue('event', { provider, raw: body });
  return c.json({ ok: true }, 200);
}

webhooksRoutes.post('/instantly', (c) => handle('instantly', c));
webhooksRoutes.post('/smartlead', (c) => handle('smartlead', c));
