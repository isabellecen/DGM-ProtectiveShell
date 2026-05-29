import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const insertCustomerSchema = createInsertSchema(customers).omit({ id: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customers.$inferSelect;

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  systemType: text("system_type").notNull(), // VEEAM, PBS, SYNOLOGY
  scheduleType: text("schedule_type").notNull().default("daily"), // daily, weekly
  scheduleTime: text("schedule_time").notNull().default("02:00"),
  daysOfWeek: text("days_of_week").array().default(sql`'{}'::text[]`),
  windowHours: integer("window_hours").notNull().default(6),
  longRunning: boolean("long_running").notNull().default(false),
  longWindowHours: integer("long_window_hours").default(24),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("jobs_system_type_check", sql`${table.systemType} IN ('VEEAM', 'PBS', 'SYNOLOGY')`),
  check("jobs_schedule_type_check", sql`${table.scheduleType} IN ('daily', 'weekly')`),
  check("jobs_schedule_time_check", sql`${table.scheduleTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  index("jobs_customer_id_idx").on(table.customerId),
  index("jobs_enabled_idx").on(table.enabled),
]);

export const insertJobSchema = createInsertSchema(jobs).omit({ id: true, createdAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobs.$inferSelect;

export const jobRules = pgTable("job_rules", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").references(() => jobs.id).notNull(),
  senderMatch: text("sender_match"),
  subjectMatch: text("subject_match"),
  bodyMatch: text("body_match"),
  priority: integer("priority").notNull().default(0),
}, (table) => [
  index("job_rules_job_id_idx").on(table.jobId),
]);

export const insertJobRuleSchema = createInsertSchema(jobRules).omit({ id: true });
export type InsertJobRule = z.infer<typeof insertJobRuleSchema>;
export type JobRule = typeof jobRules.$inferSelect;

export const expectedRuns = pgTable("expected_runs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").references(() => jobs.id).notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING, OK, WARN, FAIL, MISSING
  linkedEventId: integer("linked_event_id"),
}, (table) => [
  check("expected_runs_status_check", sql`${table.status} IN ('PENDING', 'OK', 'WARN', 'FAIL', 'MISSING')`),
  uniqueIndex("expected_runs_job_scheduled_idx").on(table.jobId, table.scheduledFor),
  index("expected_runs_status_deadline_idx").on(table.status, table.deadlineAt),
]);

export const insertExpectedRunSchema = createInsertSchema(expectedRuns).omit({ id: true });
export type InsertExpectedRun = z.infer<typeof insertExpectedRunSchema>;
export type ExpectedRun = typeof expectedRuns.$inferSelect;

export const emails = pgTable("emails", {
  id: serial("id").primaryKey(),
  folder: text("folder").notNull(),
  uidvalidity: integer("uidvalidity").notNull(),
  uid: integer("uid").notNull(),
  messageId: text("message_id"),
  fromAddr: text("from_addr"),
  subject: text("subject"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  snippet: text("snippet"),
  rawExcerpt: text("raw_excerpt"),
  ingestedOk: boolean("ingested_ok").notNull().default(false),
  matchedJobId: integer("matched_job_id").references(() => jobs.id),
}, (table) => [
  uniqueIndex("emails_folder_uid_uidvalidity_idx").on(table.folder, table.uidvalidity, table.uid),
  index("emails_matched_job_id_idx").on(table.matchedJobId),
  index("emails_received_at_idx").on(table.receivedAt),
]);

export const insertEmailSchema = createInsertSchema(emails).omit({ id: true });
export type InsertEmail = z.infer<typeof insertEmailSchema>;
export type Email = typeof emails.$inferSelect;

export const emailIngestionFailures = pgTable("email_ingestion_failures", {
  id: serial("id").primaryKey(),
  mailboxKey: text("mailbox_key").notNull(),
  uidvalidity: integer("uidvalidity").notNull(),
  uid: integer("uid").notNull(),
  errorMessage: text("error_message").notNull(),
  rawExcerpt: text("raw_excerpt"),
  attemptCount: integer("attempt_count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_ingestion_failures_mailbox_uid_idx").on(table.mailboxKey, table.uidvalidity, table.uid),
  index("email_ingestion_failures_last_seen_idx").on(table.lastSeenAt),
]);

export const insertEmailIngestionFailureSchema = createInsertSchema(emailIngestionFailures).omit({
  id: true,
  firstSeenAt: true,
  lastSeenAt: true,
});
export type InsertEmailIngestionFailure = z.infer<typeof insertEmailIngestionFailureSchema>;
export type EmailIngestionFailure = typeof emailIngestionFailures.$inferSelect;

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").references(() => jobs.id).notNull(),
  expectedRunId: integer("expected_run_id").references(() => expectedRuns.id),
  status: text("status").notNull(), // OK, WARN, FAIL, UNKNOWN
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  emailId: integer("email_id").references(() => emails.id),
}, (table) => [
  check("events_status_check", sql`${table.status} IN ('OK', 'WARN', 'FAIL', 'UNKNOWN')`),
  index("events_job_received_idx").on(table.jobId, table.receivedAt),
  index("events_expected_run_id_idx").on(table.expectedRunId),
]);

export const insertEventSchema = createInsertSchema(events).omit({ id: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

export const incidents = pgTable("incidents", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(), // BACKUP, PROXMOX, MONITOR
  sourceId: integer("source_id"),
  severity: text("severity").notNull(), // INFO, WARN, CRIT
  title: text("title").notNull(),
  details: text("details"),
  state: text("state").notNull().default("OPEN"), // OPEN, ACKED, RESOLVED
  sourceFingerprint: text("source_fingerprint"),
  notificationSentAt: timestamp("notification_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("incidents_source_type_check", sql`${table.sourceType} IN ('BACKUP', 'PROXMOX', 'MONITOR')`),
  check("incidents_severity_check", sql`${table.severity} IN ('INFO', 'WARN', 'CRIT')`),
  check("incidents_state_check", sql`${table.state} IN ('OPEN', 'ACKED', 'RESOLVED')`),
  uniqueIndex("incidents_source_fingerprint_idx").on(table.sourceFingerprint),
  index("incidents_state_created_idx").on(table.state, table.createdAt),
  index("incidents_source_idx").on(table.sourceType, table.sourceId),
]);

export const insertIncidentSchema = createInsertSchema(incidents).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIncident = z.infer<typeof insertIncidentSchema>;
export type Incident = typeof incidents.$inferSelect;

export const recipients = pgTable("recipients", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  type: text("type").notNull().default("TECH"), // TECH, CLIENT
  enabled: boolean("enabled").notNull().default(true),
});

export const insertRecipientSchema = createInsertSchema(recipients).omit({ id: true });
export type InsertRecipient = z.infer<typeof insertRecipientSchema>;
export type Recipient = typeof recipients.$inferSelect;

export const notificationRoutes = pgTable("notification_routes", {
  id: serial("id").primaryKey(),
  scopeType: text("scope_type").notNull().default("GLOBAL"), // GLOBAL, CUSTOMER, JOB
  scopeId: integer("scope_id"),
  eventType: text("event_type").notNull(), // FAIL, MISSING, WARN, DAILY_REPORT, MONITOR_DOWN
  severityMin: text("severity_min").notNull().default("WARN"),
  recipientsJson: jsonb("recipients_json"),
});

export const insertNotificationRouteSchema = createInsertSchema(notificationRoutes).omit({ id: true });
export type InsertNotificationRoute = z.infer<typeof insertNotificationRouteSchema>;
export type NotificationRoute = typeof notificationRoutes.$inferSelect;

export const proxmoxHosts = pgTable("proxmox_hosts", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  username: text("username").notNull(),
  password: text("password").notNull(),
  hostKeyFingerprint: text("host_key_fingerprint"),
  allowInsecureHostKey: boolean("allow_insecure_host_key").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  lastStatus: text("last_status").default("UNKNOWN"), // OK, WARN, CRIT, UNKNOWN
  lastStatusDetails: jsonb("last_status_details"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
}, (table) => [
  check("proxmox_hosts_last_status_check", sql`${table.lastStatus} IS NULL OR ${table.lastStatus} IN ('OK', 'WARN', 'CRIT', 'UNKNOWN')`),
  index("proxmox_hosts_enabled_idx").on(table.enabled),
  index("proxmox_hosts_customer_id_idx").on(table.customerId),
]);

export const insertProxmoxHostSchema = createInsertSchema(proxmoxHosts).omit({
  id: true,
  lastCheckAt: true,
  lastStatus: true,
  lastStatusDetails: true,
  consecutiveFailures: true,
});
export type InsertProxmoxHost = z.infer<typeof insertProxmoxHostSchema>;
export type ProxmoxHost = typeof proxmoxHosts.$inferSelect;

export const proxmoxChecks = pgTable("proxmox_checks", {
  id: serial("id").primaryKey(),
  hostId: integer("host_id").references(() => proxmoxHosts.id).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  overallStatus: text("overall_status").notNull(), // OK, WARN, CRIT, UNKNOWN
  storageType: text("storage_type"), // ZFS, MDADM, RAID, MIXED, UNKNOWN
  payloadJson: jsonb("payload_json"),
  monitoringError: text("monitoring_error"), // SSH_TIMEOUT, AUTH_FAILED, SUDO_DENIED, TOOL_MISSING
}, (table) => [
  check("proxmox_checks_status_check", sql`${table.overallStatus} IN ('OK', 'WARN', 'CRIT', 'UNKNOWN')`),
  index("proxmox_checks_host_checked_idx").on(table.hostId, table.checkedAt),
]);

export const insertProxmoxCheckSchema = createInsertSchema(proxmoxChecks).omit({ id: true });
export type InsertProxmoxCheck = z.infer<typeof insertProxmoxCheckSchema>;
export type ProxmoxCheck = typeof proxmoxChecks.$inferSelect;

export const backupTargets = pgTable("backup_targets", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  type: text("type").notNull(), // SYNOLOGY, PBS
  host: text("host").notNull(),
  port: integer("port").notNull().default(5001),
  username: text("username").notNull(),
  password: text("password").notNull(),
  tlsFingerprint: text("tls_fingerprint"),
  allowInsecureTls: boolean("allow_insecure_tls").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  totalBytes: text("total_bytes"),
  usedBytes: text("used_bytes"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  pollStatus: text("poll_status").default("UNKNOWN"), // OK, WARN, ERROR, UNKNOWN
  pollError: text("poll_error"),
  datastoresJson: jsonb("datastores_json"),
}, (table) => [
  check("backup_targets_type_check", sql`${table.type} IN ('SYNOLOGY', 'PBS')`),
  check("backup_targets_poll_status_check", sql`${table.pollStatus} IS NULL OR ${table.pollStatus} IN ('OK', 'WARN', 'ERROR', 'UNKNOWN')`),
  index("backup_targets_enabled_idx").on(table.enabled),
  index("backup_targets_customer_id_idx").on(table.customerId),
]);

export const insertBackupTargetSchema = createInsertSchema(backupTargets).omit({
  id: true,
  totalBytes: true,
  usedBytes: true,
  lastPolledAt: true,
  pollStatus: true,
  pollError: true,
  datastoresJson: true,
});
export type InsertBackupTarget = z.infer<typeof insertBackupTargetSchema>;
export type BackupTarget = typeof backupTargets.$inferSelect;

export const imapCheckpoints = pgTable("imap_checkpoints", {
  id: serial("id").primaryKey(),
  folder: text("folder").notNull().unique(),
  uidvalidity: integer("uidvalidity").notNull(),
  lastSeenUid: integer("last_seen_uid").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertImapCheckpointSchema = createInsertSchema(imapCheckpoints).omit({ id: true, updatedAt: true });
export type InsertImapCheckpoint = z.infer<typeof insertImapCheckpointSchema>;
export type ImapCheckpoint = typeof imapCheckpoints.$inferSelect;

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAppSettingSchema = createInsertSchema(appSettings).omit({ id: true, updatedAt: true });
export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettings.$inferSelect;

export const schedulerRuns = pgTable("scheduler_runs", {
  id: serial("id").primaryKey(),
  workerName: text("worker_name").notNull().unique(),
  status: text("status").notNull().default("UNKNOWN"),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  message: text("message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("scheduler_runs_status_check", sql`${table.status} IN ('UNKNOWN', 'RUNNING', 'OK', 'ERROR', 'SKIPPED')`),
  index("scheduler_runs_status_idx").on(table.status),
]);

export const insertSchedulerRunSchema = createInsertSchema(schedulerRuns).omit({ id: true, updatedAt: true });
export type InsertSchedulerRun = z.infer<typeof insertSchedulerRunSchema>;
export type SchedulerRun = typeof schedulerRuns.$inferSelect;

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull().default("system"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  summary: text("summary").notNull(),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_logs_created_at_idx").on(table.createdAt),
  index("audit_logs_entity_idx").on(table.entityType, table.entityId),
]);

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;

export const rateLimitHits = pgTable("rate_limit_hits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRateLimitHitSchema = createInsertSchema(rateLimitHits);
export type InsertRateLimitHit = z.infer<typeof insertRateLimitHitSchema>;
export type RateLimitHit = typeof rateLimitHits.$inferSelect;
