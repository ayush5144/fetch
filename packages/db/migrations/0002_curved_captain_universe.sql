ALTER TABLE "leads" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "width" integer;--> statement-breakpoint
-- Backfill `position` from existing created_at order, per table, so already
-- populated DBs get a stable left-to-right / top-to-bottom order instead of all
-- zeros. Window numbers from 0 within each table. Safe on fresh DBs (no rows).
UPDATE "leads" AS l SET "position" = o.rn
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "table_id" ORDER BY "created_at", "id") - 1) AS rn
  FROM "leads"
) AS o
WHERE l."id" = o."id";--> statement-breakpoint
UPDATE "columns" AS c SET "position" = o.rn
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "table_id" ORDER BY "created_at", "id") - 1) AS rn
  FROM "columns"
) AS o
WHERE c."id" = o."id";
