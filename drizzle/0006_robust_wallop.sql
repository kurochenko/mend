ALTER TABLE "review_messages" ADD COLUMN "processing_status" text;--> statement-breakpoint
ALTER TABLE "review_messages" ADD COLUMN "processing_claimed_at" timestamp with time zone;