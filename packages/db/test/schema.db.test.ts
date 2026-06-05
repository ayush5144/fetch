import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/client';
import { DEFAULT_TABLE_ID, leads } from '../src/schema';
import { truncateAll } from '../src/testing';

/**
 * Phase 2 — the leads.data GIN index. We force the planner to prefer indexes
 * (enable_seqscan = off) and assert the JSONB containment query plans onto the
 * named GIN index, proving filters on user columns are index-backed rather than
 * sequential scans.
 */
describe('leads.data GIN index', () => {
  beforeEach(truncateAll);

  it('the GIN index exists on leads.data', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'leads' AND indexname = 'leads_data_gin_idx'`,
    );
    const rows = (res.rows ?? res) as { indexname: string }[];
    expect(rows.length).toBe(1);
  });

  it('a containment filter on a data key uses the GIN index', async () => {
    // Seed a few rows so the table isn't trivially empty.
    for (let i = 0; i < 5; i++) {
      await db.execute(
        sql`INSERT INTO leads (id, table_id, data) VALUES (${`seed${i}`}, ${DEFAULT_TABLE_ID}, ${JSON.stringify(
          { uses_shopify: i % 2 === 0 },
        )}::jsonb)`,
      );
    }

    // SET LOCAL only holds inside a transaction, so plan within one. Forcing
    // seqscan off makes the planner reveal whether the GIN index is available.
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = await tx.execute(
        sql`EXPLAIN SELECT id FROM ${leads} WHERE ${leads.data} @> '{"uses_shopify": true}'::jsonb`,
      );
      return ((plan.rows ?? plan) as Record<string, string>[])
        .map((r) => Object.values(r)[0])
        .join('\n');
    });
    expect(text).toContain('leads_data_gin_idx');
  });
});
