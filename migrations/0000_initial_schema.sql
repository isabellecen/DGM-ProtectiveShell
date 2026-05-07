CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);

--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "backup_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 443 NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"tls_fingerprint" text,
	"allow_insecure_tls" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"total_bytes" text,
	"used_bytes" text,
	"last_polled_at" timestamp with time zone,
	"poll_status" text DEFAULT 'UNKNOWN',
	"poll_error" text,
	"datastores_json" jsonb,
	CONSTRAINT "backup_targets_type_check" CHECK ("backup_targets"."type" IN ('SYNOLOGY', 'PBS')),
	CONSTRAINT "backup_targets_poll_status_check" CHECK ("backup_targets"."poll_status" IS NULL OR "backup_targets"."poll_status" IN ('OK', 'ERROR', 'UNKNOWN'))
);

--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);

--> statement-breakpoint
CREATE TABLE "emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" integer NOT NULL,
	"uid" integer NOT NULL,
	"message_id" text,
	"from_addr" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"snippet" text,
	"raw_excerpt" text,
	"ingested_ok" boolean DEFAULT false NOT NULL,
	"matched_job_id" integer
);

--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"expected_run_id" integer,
	"status" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"email_id" integer,
	CONSTRAINT "events_status_check" CHECK ("events"."status" IN ('OK', 'WARN', 'FAIL', 'UNKNOWN'))
);

--> statement-breakpoint
CREATE TABLE "expected_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"linked_event_id" integer,
	CONSTRAINT "expected_runs_status_check" CHECK ("expected_runs"."status" IN ('PENDING', 'OK', 'WARN', 'FAIL', 'MISSING'))
);

--> statement-breakpoint
CREATE TABLE "imap_checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" integer NOT NULL,
	"last_seen_uid" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imap_checkpoints_folder_unique" UNIQUE("folder")
);

--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" integer,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"source_fingerprint" text,
	"notification_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_source_type_check" CHECK ("incidents"."source_type" IN ('BACKUP', 'PROXMOX', 'MONITOR')),
	CONSTRAINT "incidents_severity_check" CHECK ("incidents"."severity" IN ('INFO', 'WARN', 'CRIT')),
	CONSTRAINT "incidents_state_check" CHECK ("incidents"."state" IN ('OPEN', 'ACKED', 'RESOLVED'))
);

--> statement-breakpoint
CREATE TABLE "job_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"sender_match" text,
	"subject_match" text,
	"body_match" text,
	"priority" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"name" text NOT NULL,
	"system_type" text NOT NULL,
	"schedule_type" text DEFAULT 'daily' NOT NULL,
	"schedule_time" text DEFAULT '02:00' NOT NULL,
	"days_of_week" text[] DEFAULT '{}'::text[],
	"window_hours" integer DEFAULT 6 NOT NULL,
	"long_running" boolean DEFAULT false NOT NULL,
	"long_window_hours" integer DEFAULT 24,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "jobs_system_type_check" CHECK ("jobs"."system_type" IN ('VEEAM', 'PBS', 'SYNOLOGY')),
	CONSTRAINT "jobs_schedule_type_check" CHECK ("jobs"."schedule_type" IN ('daily', 'weekly')),
	CONSTRAINT "jobs_schedule_time_check" CHECK ("jobs"."schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

--> statement-breakpoint
CREATE TABLE "notification_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope_type" text DEFAULT 'GLOBAL' NOT NULL,
	"scope_id" integer,
	"event_type" text NOT NULL,
	"severity_min" text DEFAULT 'WARN' NOT NULL,
	"recipients_json" jsonb
);

--> statement-breakpoint
CREATE TABLE "proxmox_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"overall_status" text NOT NULL,
	"storage_type" text,
	"payload_json" jsonb,
	"monitoring_error" text,
	CONSTRAINT "proxmox_checks_status_check" CHECK ("proxmox_checks"."overall_status" IN ('OK', 'WARN', 'CRIT', 'UNKNOWN'))
);

--> statement-breakpoint
CREATE TABLE "proxmox_hosts" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"host_key_fingerprint" text,
	"allow_insecure_host_key" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_status" text DEFAULT 'UNKNOWN',
	"last_status_details" jsonb,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "proxmox_hosts_last_status_check" CHECK ("proxmox_hosts"."last_status" IS NULL OR "proxmox_hosts"."last_status" IN ('OK', 'WARN', 'CRIT', 'UNKNOWN'))
);

--> statement-breakpoint
CREATE TABLE "rate_limit_hits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"type" text DEFAULT 'TECH' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);

--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_name" text NOT NULL,
	"status" text DEFAULT 'UNKNOWN' NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"duration_ms" integer,
	"message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduler_runs_worker_name_unique" UNIQUE("worker_name"),
	CONSTRAINT "scheduler_runs_status_check" CHECK ("scheduler_runs"."status" IN ('UNKNOWN', 'RUNNING', 'OK', 'ERROR', 'SKIPPED'))
);

--> statement-breakpoint
ALTER TABLE "backup_targets" ADD CONSTRAINT "backup_targets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_matched_job_id_jobs_id_fk" FOREIGN KEY ("matched_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_expected_run_id_expected_runs_id_fk" FOREIGN KEY ("expected_run_id") REFERENCES "public"."expected_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "expected_runs" ADD CONSTRAINT "expected_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_rules" ADD CONSTRAINT "job_rules_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proxmox_checks" ADD CONSTRAINT "proxmox_checks_host_id_proxmox_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."proxmox_hosts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proxmox_hosts" ADD CONSTRAINT "proxmox_hosts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "backup_targets_enabled_idx" ON "backup_targets" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "backup_targets_customer_id_idx" ON "backup_targets" USING btree ("customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "emails_folder_uid_uidvalidity_idx" ON "emails" USING btree ("folder","uidvalidity","uid");
--> statement-breakpoint
CREATE INDEX "emails_matched_job_id_idx" ON "emails" USING btree ("matched_job_id");
--> statement-breakpoint
CREATE INDEX "emails_received_at_idx" ON "emails" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX "events_job_received_idx" ON "events" USING btree ("job_id","received_at");
--> statement-breakpoint
CREATE INDEX "events_expected_run_id_idx" ON "events" USING btree ("expected_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "expected_runs_job_scheduled_idx" ON "expected_runs" USING btree ("job_id","scheduled_for");
--> statement-breakpoint
CREATE INDEX "expected_runs_status_deadline_idx" ON "expected_runs" USING btree ("status","deadline_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_source_fingerprint_idx" ON "incidents" USING btree ("source_fingerprint");
--> statement-breakpoint
CREATE INDEX "incidents_state_created_idx" ON "incidents" USING btree ("state","created_at");
--> statement-breakpoint
CREATE INDEX "incidents_source_idx" ON "incidents" USING btree ("source_type","source_id");
--> statement-breakpoint
CREATE INDEX "job_rules_job_id_idx" ON "job_rules" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX "jobs_customer_id_idx" ON "jobs" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "jobs_enabled_idx" ON "jobs" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "proxmox_checks_host_checked_idx" ON "proxmox_checks" USING btree ("host_id","checked_at");
--> statement-breakpoint
CREATE INDEX "proxmox_hosts_enabled_idx" ON "proxmox_hosts" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "proxmox_hosts_customer_id_idx" ON "proxmox_hosts" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "scheduler_runs_status_idx" ON "scheduler_runs" USING btree ("status");