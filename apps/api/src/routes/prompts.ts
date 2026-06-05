import { Hono } from 'hono';
import { z } from 'zod';
import { db, prompts } from '@fetch/db';
import { desc, eq } from 'drizzle-orm';

/**
 * /prompts — versioned templates for the enrichment agent and personalization.
 * Editing a prompt creates a NEW version row (a fresh insert with version+1)
 * rather than mutating the old one, so copy already approved under an earlier
 * version is never silently changed.
 */
export const promptsRoutes = new Hono();

promptsRoutes.get('/', async (c) => {
  const rows = await db.query.prompts.findMany({ orderBy: [desc(prompts.createdAt)] });
  return c.json({ prompts: rows });
});

const createSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  guardrails: z
    .object({
      maxLength: z.number().optional(),
      requiredVars: z.array(z.string()).optional(),
      bannedClaims: z.array(z.string()).optional(),
    })
    .default({}),
});

promptsRoutes.post('/', async (c) => {
  const body = createSchema.parse(await c.req.json());
  const [created] = await db.insert(prompts).values({ ...body, version: 1 }).returning();
  return c.json({ prompt: created }, 201);
});

/** Save an edit as a new version, preserving the prior one. */
promptsRoutes.post('/:name/version', async (c) => {
  const name = c.req.param('name');
  const body = createSchema.partial().parse(await c.req.json());

  const latest = await db.query.prompts.findFirst({
    where: eq(prompts.name, name),
    orderBy: [desc(prompts.version)],
  });
  if (!latest) return c.json({ error: 'unknown prompt' }, 404);

  const [created] = await db
    .insert(prompts)
    .values({
      name,
      version: latest.version + 1,
      body: body.body ?? latest.body,
      guardrails: body.guardrails ?? latest.guardrails,
    })
    .returning();
  return c.json({ prompt: created }, 201);
});
