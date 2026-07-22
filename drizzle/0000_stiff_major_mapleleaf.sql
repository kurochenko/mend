CREATE TABLE "review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer NOT NULL,
	"commit_sha" text,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"workflow_run_id" text,
	"webhook_payload" jsonb,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
