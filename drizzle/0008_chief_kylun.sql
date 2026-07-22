CREATE TABLE "mr_status_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_key" text NOT NULL,
	"mr_iid" integer NOT NULL,
	"note_id" integer,
	"rendered_body" text NOT NULL,
	"rendered_body_hash" text NOT NULL,
	"sync_action" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mr_status_notes_mr_idx" ON "mr_status_notes" USING btree ("project_key","mr_iid");