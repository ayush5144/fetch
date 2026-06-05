import { Hono } from 'hono';
import { z } from 'zod';
import { estimateCost } from '@fetch/llm';

/**
 * /estimate-cost (Phase E §4). Given a provider/model and a row count, return
 * the estimated USD to run a Dogi over those rows — shown in the UI BEFORE
 * firing so a big run can't surprise the operator. Uses the static pricing
 * table + a token heuristic in `@fetch/llm`. 400 on an unknown provider/model.
 */
export const estimateRoutes = new Hono();

const schema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  rows: z.number().int().nonnegative(),
  webSearch: z.boolean().optional(),
});

estimateRoutes.post('/', async (c) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'provider, model, and rows are required' }, 400);
  }
  try {
    const { perRow, total, breakdown } = estimateCost(body);
    return c.json({ perRow, total, breakdown });
  } catch {
    return c.json({ error: 'unknown provider or model' }, 400);
  }
});
