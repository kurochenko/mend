CREATE TYPE "public"."service_runtime_mode" AS ENUM('running', 'draining');--> statement-breakpoint
CREATE TABLE "mr_review_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer NOT NULL,
	"running_event" jsonb,
	"running_payload" jsonb,
	"running_commit_sha" text,
	"pending_event" jsonb,
	"pending_payload" jsonb,
	"pending_commit_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_runtime" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" "service_runtime_mode" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
