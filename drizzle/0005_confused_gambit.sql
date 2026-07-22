CREATE TABLE "review_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer,
	"thread_id" text,
	"source_message_id" text,
	"kind" text NOT NULL,
	"instruction" text NOT NULL,
	"match_fingerprint" text,
	"match_path" text,
	"match_line" integer,
	"match_category" text,
	"metadata" jsonb,
	"created_by_external_id" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_memory_events" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_entry_id" text,
	"project_key" text NOT NULL,
	"mr_iid" integer,
	"thread_id" text,
	"message_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_threads" ALTER COLUMN "review_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_memory_entries" ADD CONSTRAINT "review_memory_entries_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_memory_entries" ADD CONSTRAINT "review_memory_entries_source_message_id_review_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."review_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_memory_events" ADD CONSTRAINT "review_memory_events_memory_entry_id_review_memory_entries_id_fk" FOREIGN KEY ("memory_entry_id") REFERENCES "public"."review_memory_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_memory_events" ADD CONSTRAINT "review_memory_events_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_memory_events" ADD CONSTRAINT "review_memory_events_message_id_review_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."review_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_memory_entries_scope_idx" ON "review_memory_entries" USING btree ("scope","project_key","mr_iid");--> statement-breakpoint
CREATE INDEX "review_memory_entries_thread_idx" ON "review_memory_entries" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "review_memory_entries_status_idx" ON "review_memory_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "review_memory_events_memory_idx" ON "review_memory_events" USING btree ("memory_entry_id");--> statement-breakpoint
CREATE INDEX "review_memory_events_thread_idx" ON "review_memory_events" USING btree ("thread_id");