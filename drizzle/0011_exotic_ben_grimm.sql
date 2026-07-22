CREATE TYPE "public"."review_finding_state" AS ENUM('pending', 'accepted', 'rejected', 'deferred', 'fixed', 'not_fixed', 'resolved');--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer NOT NULL,
	"review_run_id" text,
	"thread_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"provider_note_id" text,
	"state" "review_finding_state" NOT NULL,
	"decision_reason" text,
	"decided_by_external_id" text,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_findings_provider_thread_idx" ON "review_findings" USING btree ("provider","provider_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_findings_thread_idx" ON "review_findings" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "review_findings_mr_idx" ON "review_findings" USING btree ("project_key","mr_iid");--> statement-breakpoint
CREATE INDEX "review_findings_run_idx" ON "review_findings" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "review_findings_state_idx" ON "review_findings" USING btree ("state");