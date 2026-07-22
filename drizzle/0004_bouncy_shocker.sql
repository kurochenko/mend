CREATE TABLE "review_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"provider" text NOT NULL,
	"review_run_id" text,
	"author_type" text NOT NULL,
	"author_external_id" text,
	"author_name" text,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"body_normalized" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_parent_message_id" text,
	"provider_url" text,
	"raw_provider_data" jsonb,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"project_key" text NOT NULL,
	"repo_external_id" text NOT NULL,
	"review_external_id" integer NOT NULL,
	"review_run_id" text NOT NULL,
	"thread_kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"path" text,
	"line" integer,
	"finding_fingerprint" text,
	"status" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"provider_url" text,
	"raw_provider_data" jsonb,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_messages" ADD CONSTRAINT "review_messages_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_messages_provider_message_idx" ON "review_messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "review_messages_thread_idx" ON "review_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "review_messages_run_idx" ON "review_messages" USING btree ("review_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_threads_provider_thread_idx" ON "review_threads" USING btree ("provider","provider_thread_id");--> statement-breakpoint
CREATE INDEX "review_threads_run_idx" ON "review_threads" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "review_threads_review_idx" ON "review_threads" USING btree ("project_key","review_external_id");