import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/client';
import { DEFAULT_TABLE_ID } from '../src/schema';
import { truncateAll } from '../src/testing';

/**
 * Phase B migration backfill (0002). The migration seeds `position` from
 * created_at order within each table via a window function. The schema column
 * now exists (the suite runs migrations first), so here we re-assert the exact
 * backfill statement: rows inserted out of position order get renumbered 0..n-1
 * by created_at, independently per table, and a second table doesn't bleed in.
 */

const BACKFILL_LEADS = sql`
  UPDATE "leads" AS l SET "position" = o.rn
  FROM (
    SELECT "id", (row_number() OVER (PARTITION BY "table_id" ORDER BY "created_at", "id") - 1) AS rn
    FROM "leads"
  ) AS o
  WHERE l."id" = o."id"`;

describe('migration 0002 position backfill', () => {
  beforeEach(truncateAll);

  it('numbers rows 0..n-1 by created_at per table, all starting from 0', async () => {
    // A second table to prove partitioning.
    await db.execute(sql`INSERT INTO tables (id, name) VALUES ('tbl_other', 'Other')`);

    // Insert with deliberately wrong positions and staggered created_at.
    const mk = (id: string, table: string, ts: string) =>
      db.execute(
        sql`INSERT INTO leads (id, table_id, position, created_at) VALUES (${id}, ${table}, 999, ${ts})`,
      );
    await mk('a', DEFAULT_TABLE_ID, '2026-01-01T00:00:00Z');
    await mk('b', DEFAULT_TABLE_ID, '2026-01-02T00:00:00Z');
    await mk('c', DEFAULT_TABLE_ID, '2026-01-03T00:00:00Z');
    await mk('x', 'tbl_other', '2026-01-05T00:00:00Z');
    await mk('y', 'tbl_other', '2026-01-04T00:00:00Z');

    await db.execute(BACKFILL_LEADS);

    const res = await db.execute<{ id: string; table_id: string; position: number }>(
      sql`SELECT id, table_id, position FROM leads ORDER BY table_id, position`,
    );
    const rows = (res.rows ?? res) as { id: string; table_id: string; position: number }[];
    const pos = Object.fromEntries(rows.map((r) => [r.id, r.position]));

    // Default table: a<b<c by created_at → 0,1,2.
    expect(pos.a).toBe(0);
    expect(pos.b).toBe(1);
    expect(pos.c).toBe(2);
    // Other table renumbers independently from 0: y is earlier than x.
    expect(pos.y).toBe(0);
    expect(pos.x).toBe(1);
  });

  it('is a no-op-safe on an empty table', async () => {
    await db.execute(BACKFILL_LEADS); // no rows → must not throw
    const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM leads`);
    const rows = (res.rows ?? res) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });
});
