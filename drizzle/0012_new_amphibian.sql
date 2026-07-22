CREATE TYPE "public"."fix_batch_status" AS ENUM('pending', 'running');--> statement-breakpoint
CREATE TABLE "mr_fix_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer NOT NULL,
	"status" "fix_batch_status" NOT NULL,
	"force" boolean NOT NULL,
	"request_note_id" text,
	"request_thread_id" text,
	"requested_by_external_id" text,
	"requested_by_name" text,
	"accepted_finding_ids" jsonb NOT NULL,
	"pending_finding_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mr_fix_batches_mr_idx" ON "mr_fix_batches" USING btree ("project_key","mr_iid");--> statement-breakpoint
CREATE INDEX "mr_fix_batches_status_idx" ON "mr_fix_batches" USING btree ("status");