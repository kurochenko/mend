CREATE TYPE "public"."improvement_proposal_status" AS ENUM('proposed', 'accepted', 'dismissed', 'shipped');--> statement-breakpoint
CREATE TYPE "public"."improvement_proposal_type" AS ENUM('tooling', 'instructions', 'process');--> statement-breakpoint
CREATE TABLE "improvement_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"cluster_slug" text NOT NULL,
	"title" text NOT NULL,
	"proposal_type" "improvement_proposal_type" NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"occurrence_count" integer NOT NULL,
	"status" "improvement_proposal_status" NOT NULL,
	"last_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_proposals_cluster_idx" ON "improvement_proposals" USING btree ("project_key","cluster_slug");--> statement-breakpoint
CREATE INDEX "improvement_proposals_status_idx" ON "improvement_proposals" USING btree ("status");