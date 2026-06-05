import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Phase 11 — optional API auth. Verified in isolation with a tiny app so no DB
 * is needed. `getEnv()` caches on first call, so each scenario sets env before
 * the first request and resets modules between the two token states.
 */
function buildApp(authMw: () => any) {
  const app = new Hono();
  app.use('*', authMw());
  app.get('/health', (c) => c.text('ok'));
  app.get('/leads', (c) => c.text('data'));
  app.post('/webhooks/instantly', (c) => c.text('wh'));
  return app;
}

describe('auth middleware — token configured', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://x:y@localhost:5432/z');
    vi.stubEnv('FETCH_API_TOKEN', 'secret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a data route with no/!wrong bearer and accepts the right one', async () => {
    const { auth } = await import('../src/middleware/auth');
    const app = buildApp(auth);

    expect((await app.request('/leads')).status).toBe(401);
    expect((await app.request('/leads', { headers: { authorization: 'Bearer nope' } })).status).toBe(
      401,
    );
    expect(
      (await app.request('/leads', { headers: { authorization: 'Bearer secret' } })).status,
    ).toBe(200);
  });

  it('always exempts /health and /webhooks (which use signature auth)', async () => {
    const { auth } = await import('../src/middleware/auth');
    const app = buildApp(auth);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/webhooks/instantly', { method: 'POST' })).status).toBe(200);
  });
});

describe('auth middleware — no token (self-host default)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://x:y@localhost:5432/z');
    vi.stubEnv('FETCH_API_TOKEN', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is open: every route passes through unauthenticated', async () => {
    const { auth } = await import('../src/middleware/auth');
    const app = buildApp(auth);
    expect((await app.request('/leads')).status).toBe(200);
  });
});
