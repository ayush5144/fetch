import { Hono } from 'hono';
import { z } from 'zod';
import { auditLog, db } from '@fetch/db';
import { desc, sql } from 'drizzle-orm';

/**
 * /activity — a workspace-wide activity feed over `audit_log` (G.2c). Surfaces
 * what happened (and who did it) newest-first, paginated, so the UI can show an
 * Activity view next to Jobs: columns created, cells filled, dedupe, plans, etc.
 *
 * `audit_log` has no `table_id`, so this feed is intentionally workspace-wide —
 * we do not invent table scoping here.
 */
export const activityRoutes = new Hono();

/** One audit row as returned to the client. */
export interface AuditRow {
  id: string;
  actor: string;
  entity: string;
  entityId: string;
  action: string;
  diff: unknown;
  createdAt: Date;
}

const MAX_LIMIT = 200;

const querySchema = z.object({
  // Validate as a positive int (default 50); the max is clamped, not rejected,
  // so an over-large `limit` still succeeds capped at MAX_LIMIT.
  limit: z.coerce.number().int().min(1).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /activity?limit=50&offset=0 → { activity: AuditRow[], total }.
 * Newest first (createdAt desc). `total` is the full row count for paging.
 */
activityRoutes.get('/', async (c) => {
  const parsed = querySchema.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  const limit = Math.min(parsed.limit, MAX_LIMIT);
  const offset = parsed.offset;

  const rows = await db.query.auditLog.findMany({
    orderBy: [desc(auditLog.createdAt)],
    limit,
    offset,
  });

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog);
  const total = countRow?.count ?? 0;

  const activity: AuditRow[] = rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    entity: r.entity,
    entityId: r.entityId,
    action: r.action,
    diff: r.diff,
    createdAt: r.createdAt,
  }));

  return c.json({ activity, total });
});
