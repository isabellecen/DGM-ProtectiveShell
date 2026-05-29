CREATE TABLE "email_ingestion_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"mailbox_key" text NOT NULL,
	"uidvalidity" integer NOT NULL,
	"uid" integer NOT NULL,
	"error_message" text NOT NULL,
	"raw_excerpt" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_targets" DROP CONSTRAINT "backup_targets_poll_status_check";--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingestion_failures_mailbox_uid_idx" ON "email_ingestion_failures" USING btree ("mailbox_key","uidvalidity","uid");--> statement-breakpoint
CREATE INDEX "email_ingestion_failures_last_seen_idx" ON "email_ingestion_failures" USING btree ("last_seen_at");--> statement-breakpoint
ALTER TABLE "backup_targets" ADD CONSTRAINT "backup_targets_poll_status_check" CHECK ("backup_targets"."poll_status" IS NULL OR "backup_targets"."poll_status" IN ('OK', 'WARN', 'ERROR', 'UNKNOWN'));