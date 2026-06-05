import { Hono } from 'hono';
import { accounts, db, leads } from '@fetch/db';
import { desc, eq } from 'drizzle-orm';

/**
 * /accounts — the company view. An account is enriched once and shared by every
 * lead at its domain, so this lists the account plus its attached leads.
 */
export const accountsRoutes = new Hono();

accountsRoutes.get('/', async (c) => {
  const rows = await db.query.accounts.findMany({ orderBy: [desc(accounts.createdAt)] });
  return c.json({ accounts: rows });
});

accountsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) return c.json({ error: 'not found' }, 404);
  const attached = await db.query.leads.findMany({ where: eq(leads.accountId, id) });
  return c.json({ account, leads: attached });
});
