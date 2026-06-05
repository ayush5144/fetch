CREATE TABLE "tables" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the default table so existing leads/columns have somewhere to live.
INSERT INTO "tables" ("id", "name", "description")
VALUES ('tbl_default_leads', 'Leads', 'Default table')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "columns" DROP CONSTRAINT "columns_key_unique";--> statement-breakpoint
-- Add table_id as NULLABLE, backfill existing rows, then enforce NOT NULL.
ALTER TABLE "leads" ADD COLUMN "table_id" text;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "table_id" text;--> statement-breakpoint
UPDATE "leads" SET "table_id" = 'tbl_default_leads' WHERE "table_id" IS NULL;--> statement-breakpoint
UPDATE "columns" SET "table_id" = 'tbl_default_leads' WHERE "table_id" IS NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "table_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "columns" ALTER COLUMN "table_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_table_idx" ON "leads" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "columns_table_key_idx" ON "columns" USING btree ("table_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "columns_table_label_idx" ON "columns" USING btree ("table_id","label");
