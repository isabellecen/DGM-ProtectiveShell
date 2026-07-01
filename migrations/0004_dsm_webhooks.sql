ALTER TABLE "events" DROP CONSTRAINT "events_source_type_check";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_webhook_source_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_type_check" CHECK ("events"."source_type" IN ('EMAIL', 'PROXMOX_WEBHOOK', 'BACKUP_WEBHOOK'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_webhook_source_check" CHECK ("jobs"."webhook_source" IS NULL OR "jobs"."webhook_source" IN ('PVE', 'PBS', 'DSM'));
