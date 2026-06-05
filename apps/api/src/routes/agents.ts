import { Hono } from 'hono';
import { z } from 'zod';
import { agents, db } from '@fetch/db';
import { desc, eq } from 'drizzle-orm';

/**
 * /agents — saved, reusable Dogis (Phase E §7). A configured cell-Dogi or a
 * whole goal-plan is named and stored here, then reused: the client reads a
 * saved agent's `config` and pre-fills a new column (or an Ask-Dogi). Reuse is
 * purely client-side, so this is a plain named CRUD over the `agents` table.
 */
export const agentsRoutes = new Hono();

/** List saved agents, newest first. */
agentsRoutes.get('/', async (c) => {
  const rows = await db.query.agents.findMany({ orderBy: [desc(agents.createdAt)] });
  return c.json({ agents: rows });
});

const createSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['dogi', 'plan']),
  config: z.record(z.unknown()).default({}),
});

/** Save a Dogi config or goal-plan under a name. */
agentsRoutes.post('/', async (c) => {
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'name, kind (dogi|plan), and config are required' }, 400);
  }
  const [created] = await db.insert(agents).values(body).returning();
  return c.json({ agent: created }, 201);
});

/** Delete a saved agent. */
agentsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(agents).where(eq(agents.id, id)).returning();
  if (!deleted) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
