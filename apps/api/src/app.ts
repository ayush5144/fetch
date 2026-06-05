import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { rateLimit } from './middleware/rateLimit';
import { accountsRoutes } from './routes/accounts';
import { analyticsRoutes } from './routes/analytics';
import { campaignsRoutes } from './routes/campaigns';
import { columnsRoutes } from './routes/columns';
import { healthRoutes } from './routes/health';
import { jobsRoutes } from './routes/jobs';
import { leadsRoutes } from './routes/leads';
import { promptsRoutes } from './routes/prompts';
import { webhooksRoutes } from './routes/webhooks';

/**
 * The Hono app: middleware + mounted route modules. Each resource lives in its
 * own router so the front door stays readable. CORS is open to the web app's
 * origin; public endpoints are rate-limited.
 */
export const app = new Hono();

app.use('*', honoLogger());
app.use('*', cors());

// Rate-limit the public surface (webhooks + imports) to blunt abuse.
app.use('/webhooks/*', rateLimit({ windowMs: 60_000, max: 120 }));
app.use('/leads/import', rateLimit({ windowMs: 60_000, max: 30 }));

app.route('/', healthRoutes);
app.route('/leads', leadsRoutes);
app.route('/accounts', accountsRoutes);
app.route('/columns', columnsRoutes);
app.route('/campaigns', campaignsRoutes);
app.route('/prompts', promptsRoutes);
app.route('/jobs', jobsRoutes);
app.route('/analytics', analyticsRoutes);
app.route('/webhooks', webhooksRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  return c.json({ error: err.message }, 500);
});
