ALTER TYPE "public"."fix_batch_status" ADD VALUE 'completed';--> statement-breakpoint
ALTER TYPE "public"."fix_batch_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "mr_fix_batches" ADD COLUMN "loop_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mr_fix_batches" ADD COLUMN "source_branch" text;--> statement-breakpoint
ALTER TABLE "mr_fix_batches" ADD COLUMN "pushed_commit_sha" text;--> statement-breakpoint
ALTER TABLE "mr_fix_batches" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "mr_fix_batches" ADD COLUMN "failure_message" text;