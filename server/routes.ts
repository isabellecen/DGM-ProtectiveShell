import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { pollBackupTargetAndPersist, runProxmoxHostCheck } from "./monitoring";
import { testImapConnection } from "./emailPoller";
import { testSmtpConnection } from "./notificationService";
import { z } from "zod";

const idParamSchema = z.coerce.number().int().positive();
const nullableIdSchema = z.union([z.coerce.number().int().positive(), z.null()]);
const systemTypeSchema = z.enum(["VEEAM", "PBS", "SYNOLOGY"]);
const backupTargetTypeSchema = z.enum(["SYNOLOGY", "PBS"]);
const scheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dayOfWeekSchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

const allowedSettingKeys = [
  "APP_TIMEZONE",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASS",
  "IMAP_FOLDER",
  "IMAP_TLS",
  "IMAP_FETCH_LIMIT",
  "IMAP_POLL_INTERVAL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_STARTTLS",
  "CONSECUTIVE_FAILURE_THRESHOLD",
  "RETENTION_DAYS",
  "SSH_TIMEOUT",
  "DAILY_REPORT_TIME",
] as const;

type SettingKey = (typeof allowedSettingKeys)[number];

const settingKeySchema = z.enum(allowedSettingKeys);
const booleanSettingKeys = new Set<SettingKey>(["IMAP_TLS", "SMTP_STARTTLS"]);
const numericSettingRanges: Partial<Record<SettingKey, { min: number; max: number }>> = {
  IMAP_PORT: { min: 1, max: 65535 },
  IMAP_FETCH_LIMIT: { min: 1, max: 200 },
  IMAP_POLL_INTERVAL: { min: 1, max: 1440 },
  SMTP_PORT: { min: 1, max: 65535 },
  CONSECUTIVE_FAILURE_THRESHOLD: { min: 1, max: 100 },
  RETENTION_DAYS: { min: 1, max: 3650 },
  SSH_TIMEOUT: { min: 1, max: 300 },
};

const customerPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
}).strict();
const customerCreateSchema = customerPatchSchema.required();

const jobBaseSchema = z.object({
  name: z.string().trim().min(1),
  systemType: systemTypeSchema,
  customerId: nullableIdSchema.optional(),
  scheduleType: z.enum(["daily", "weekly"]).default("daily"),
  scheduleTime: scheduleTimeSchema.default("02:00"),
  windowHours: z.coerce.number().int().min(1).max(168).default(6),
  enabled: z.boolean().default(true),
  longRunning: z.boolean().default(false),
  longWindowHours: z.coerce.number().int().min(1).max(336).default(24),
  daysOfWeek: z.array(dayOfWeekSchema).default([]),
}).strict();

const jobCreateSchema = jobBaseSchema.superRefine((data, ctx) => {
  if (data.scheduleType === "weekly" && data.daysOfWeek.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daysOfWeek"],
      message: "Select at least one weekday for weekly jobs",
    });
  }
});

const jobPatchSchema = jobBaseSchema.partial().superRefine((data, ctx) => {
  if (data.scheduleType === "weekly" && data.daysOfWeek?.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daysOfWeek"],
      message: "Select at least one weekday for weekly jobs",
    });
  }
});

const proxmoxHostCreateSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  hostKeyFingerprint: z.string().trim().nullable().optional(),
  allowInsecureHostKey: z.boolean().default(false),
  customerId: nullableIdSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();

const proxmoxHostPatchSchema = proxmoxHostCreateSchema.partial().strict();

const backupTargetCreateSchema = z.object({
  name: z.string().trim().min(1),
  type: backupTargetTypeSchema,
  host: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  tlsFingerprint: z.string().trim().nullable().optional(),
  allowInsecureTls: z.boolean().default(false),
  customerId: nullableIdSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();

const backupTargetPatchSchema = backupTargetCreateSchema.partial().strict();

const recipientCreateSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
  type: z.enum(["TECH", "CLIENT"]).default("TECH"),
  customerId: nullableIdSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();
const recipientPatchSchema = recipientCreateSchema.partial().strict();

const jobRuleCreateSchema = z.object({
  jobId: idParamSchema,
  senderMatch: z.string().trim().nullable().optional(),
  subjectMatch: z.string().trim().nullable().optional(),
  bodyMatch: z.string().trim().nullable().optional(),
  priority: z.coerce.number().int().default(0),
}).strict().superRefine((data, ctx) => {
  if (![data.senderMatch, data.subjectMatch, data.bodyMatch].some((value) => !!value?.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["senderMatch"],
      message: "Set at least one sender, subject, or body match value",
    });
  }
});

const settingSchema = z.object({
  key: settingKeySchema,
  value: z.string().default(""),
}).strict().superRefine((data, ctx) => {
  const value = data.value.trim();
  if (value === "") {
    return;
  }

  const range = numericSettingRanges[data.key];
  if (range) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${data.key} must be an integer from ${range.min} to ${range.max}`,
      });
    }
  }

  if (booleanSettingKeys.has(data.key) && value !== "0" && value !== "1") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: `${data.key} must be 0 or 1`,
    });
  }

  if (data.key === "APP_TIMEZONE") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "APP_TIMEZONE must be a valid IANA timezone",
      });
    }
  }

  if (data.key === "DAILY_REPORT_TIME" && !scheduleTimeSchema.safeParse(value).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "DAILY_REPORT_TIME must use HH:MM format",
    });
  }
});

const notificationRouteCreateSchema = z.object({
  scopeType: z.enum(["GLOBAL", "CUSTOMER", "JOB"]).default("GLOBAL"),
  scopeId: nullableIdSchema.optional(),
  eventType: z.enum(["FAIL", "MISSING", "WARN", "DAILY_REPORT", "MONITOR_DOWN"]),
  severityMin: z.enum(["INFO", "WARN", "CRIT"]).default("WARN"),
  recipientsJson: z.array(idParamSchema).default([]),
}).strict().superRefine((data, ctx) => {
  if (data.scopeType !== "GLOBAL" && !data.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scopeId"],
      message: "Choose a customer or job for scoped routes",
    });
  }
});

const retentionRunSchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(3650).optional(),
}).strict();

function parseId(value: unknown) {
  return idParamSchema.parse(value);
}

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function assertInsecureTargetAllowed(kind: "SSH host key" | "target TLS", allowInsecure?: boolean) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_INSECURE_TARGETS !== "1" &&
    allowInsecure === true
  ) {
    throw badRequest(
      `${kind} bypasses are disabled in production. Add a fingerprint or set ALLOW_PRODUCTION_INSECURE_TARGETS=1 intentionally.`,
    );
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Dashboard
  app.get("/api/dashboard/stats", async (_req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  });

  // Customers
  app.get("/api/customers", async (_req, res) => {
    const result = await storage.getCustomers();
    res.json(result);
  });

  app.post("/api/customers", async (req, res) => {
    const data = customerCreateSchema.parse(req.body);
    const result = await storage.createCustomer(data);
    res.status(201).json(result);
  });

  app.patch("/api/customers/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const data = customerPatchSchema.parse(req.body);
    const result = await storage.updateCustomer(id, data);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json(result);
  });

  app.delete("/api/customers/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteCustomer(id);
    res.status(204).send();
  });

  // Jobs
  app.get("/api/jobs", async (_req, res) => {
    const result = await storage.getJobs();
    res.json(result);
  });

  app.post("/api/jobs", async (req, res) => {
    const data = jobCreateSchema.parse(req.body);
    const result = await storage.createJob({
      ...data,
      customerId: data.customerId ?? null,
    });
    res.status(201).json(result);
  });

  app.patch("/api/jobs/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const data = jobPatchSchema.parse(req.body);
    const result = await storage.updateJob(id, data);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json(result);
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteJob(id);
    res.status(204).send();
  });

  // Proxmox Hosts
  app.get("/api/proxmox-hosts", async (_req, res) => {
    const result = await storage.getProxmoxHosts();
    const sanitized = result.map((h) => ({
      ...h,
      password: "***",
    }));
    res.json(sanitized);
  });

  app.get("/api/proxmox-hosts/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const host = await storage.getProxmoxHost(id);
    if (!host) return res.status(404).json({ message: "Not found" });
    const allHosts = await storage.getProxmoxHosts();
    const withCustomer = allHosts.find(h => h.id === id);
    res.json({ ...(withCustomer || host), password: "***" });
  });

  app.post("/api/proxmox-hosts", async (req, res) => {
    const data = proxmoxHostCreateSchema.parse(req.body);
    assertInsecureTargetAllowed("SSH host key", data.allowInsecureHostKey);
    const result = await storage.createProxmoxHost({
      ...data,
      customerId: data.customerId ?? null,
      hostKeyFingerprint: data.hostKeyFingerprint || null,
    });
    res.status(201).json({ ...result, password: "***" });
  });

  app.patch("/api/proxmox-hosts/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await storage.getProxmoxHost(id);
    if (!existing) return res.status(404).json({ message: "Not found" });

    const updateData = proxmoxHostPatchSchema.parse(req.body);
    assertInsecureTargetAllowed("SSH host key", updateData.allowInsecureHostKey);

    const result = await storage.updateProxmoxHost(id, updateData);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json({ ...result, password: "***" });
  });

  app.delete("/api/proxmox-hosts/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteProxmoxHost(id);
    res.status(204).send();
  });

  app.get("/api/proxmox-hosts/:id/checks", async (req, res) => {
    const id = parseId(req.params.id);
    const limit = req.query.limit ? z.coerce.number().int().min(1).max(100).parse(req.query.limit) : 20;
    const checks = await storage.getProxmoxChecks(id, limit);
    res.json(checks);
  });

  app.post("/api/proxmox-hosts/:id/run-check", async (req, res) => {
    const id = parseId(req.params.id);
    const check = await runProxmoxHostCheck(id);
    if (!check) return res.status(404).json({ message: "Host not found" });

    res.json(check);
  });


  // Backup Targets
  app.get("/api/backup-targets", async (_req, res) => {
    const result = await storage.getBackupTargets();
    const sanitized = result.map((t) => ({
      ...t,
      password: "***",
    }));
    res.json(sanitized);
  });

  app.get("/api/backup-targets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const target = await storage.getBackupTarget(id);
    if (!target) return res.status(404).json({ message: "Not found" });
    const allTargets = await storage.getBackupTargets();
    const withCustomer = allTargets.find(t => t.id === id);
    res.json({ ...(withCustomer || target), password: "***" });
  });

  app.post("/api/backup-targets", async (req, res) => {
    const data = backupTargetCreateSchema.parse(req.body);
    assertInsecureTargetAllowed("target TLS", data.allowInsecureTls);
    const result = await storage.createBackupTarget({
      ...data,
      port: data.port || (data.type === "PBS" ? 8007 : 443),
      customerId: data.customerId ?? null,
      tlsFingerprint: data.tlsFingerprint || null,
    });
    res.status(201).json({ ...result, password: "***" });
  });

  app.patch("/api/backup-targets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await storage.getBackupTarget(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    const updateData = backupTargetPatchSchema.parse(req.body);
    assertInsecureTargetAllowed("target TLS", updateData.allowInsecureTls);
    const result = await storage.updateBackupTarget(id, updateData);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json({ ...result, password: "***" });
  });

  app.delete("/api/backup-targets/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteBackupTarget(id);
    res.status(204).send();
  });

  app.post("/api/backup-targets/:id/poll", async (req, res) => {
    const id = parseId(req.params.id);
    const target = await pollBackupTargetAndPersist(id);
    if (!target) return res.status(404).json({ message: "Not found" });
    const allTargets = await storage.getBackupTargets();
    const withCustomer = allTargets.find(t => t.id === id);
    res.json({ ...(withCustomer || target), password: "***" });
  });

  // Incidents
  app.get("/api/incidents", async (_req, res) => {
    const result = await storage.getIncidents();
    res.json(result);
  });

  app.patch("/api/incidents/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const { state } = z.object({ state: z.enum(["OPEN", "ACKED", "RESOLVED"]) }).strict().parse(req.body);
    const result = await storage.updateIncidentState(id, state);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json(result);
  });

  // Recipients
  app.get("/api/recipients", async (_req, res) => {
    const result = await storage.getRecipients();
    res.json(result);
  });

  app.post("/api/recipients", async (req, res) => {
    const { name, email, type, customerId, enabled } = recipientCreateSchema.parse(req.body);
    const result = await storage.createRecipient({
      name,
      email,
      type,
      customerId: customerId ?? null,
      enabled,
    });
    res.status(201).json(result);
  });

  app.patch("/api/recipients/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const data = recipientPatchSchema.parse(req.body);
    const result = await storage.updateRecipient(id, data);
    if (!result) return res.status(404).json({ message: "Not found" });
    res.json(result);
  });

  app.delete("/api/recipients/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteRecipient(id);
    res.status(204).send();
  });

  // Job Rules
  app.get("/api/job-rules", async (req, res) => {
    const jobId = req.query.jobId ? idParamSchema.parse(req.query.jobId) : undefined;
    const result = await storage.getJobRules(jobId);
    res.json(result);
  });

  app.post("/api/job-rules", async (req, res) => {
    const { jobId, senderMatch, subjectMatch, bodyMatch, priority } = jobRuleCreateSchema.parse(req.body);
    const job = await storage.getJob(jobId);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const result = await storage.createJobRule({
      jobId,
      senderMatch: senderMatch || null,
      subjectMatch: subjectMatch || null,
      bodyMatch: bodyMatch || null,
      priority: priority || 0,
    });
    res.status(201).json(result);
  });

  app.delete("/api/job-rules/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteJobRule(id);
    res.status(204).send();
  });

  // Expected Runs (read-only for UI)
  app.get("/api/expected-runs", async (_req, res) => {
    const result = await storage.getExpectedRuns(50);
    res.json(result);
  });

  // Emails
  app.get("/api/emails", async (_req, res) => {
    const result = await storage.getEmails(50);
    res.json(result);
  });

  app.get("/api/emails/unmatched", async (_req, res) => {
    const result = await storage.getUnmatchedEmails();
    res.json(result);
  });

  app.get("/api/emails/matched", async (_req, res) => {
    const result = await storage.getMatchedEmails(50);
    res.json(result);
  });

  app.get("/api/emails/unmatched-count", async (_req, res) => {
    const count = await storage.getUnmatchedEmailCount();
    res.json({ count });
  });

  app.get("/api/emails/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const result = await storage.getEmail(id);
    if (!result) {
      return res.status(404).json({ message: "Email not found" });
    }
    res.json(result);
  });

  app.post("/api/emails/:id/link-job", async (req, res) => {
    const emailId = parseId(req.params.id);
    const { jobId } = z.object({ jobId: idParamSchema }).strict().parse(req.body);
    const job = await storage.getJob(jobId);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const result = await storage.linkEmailToJob(emailId, jobId);
    if (!result) {
      return res.status(404).json({ message: "Email not found" });
    }
    res.json(result);
  });

  // Events (read-only for UI)
  app.get("/api/events", async (_req, res) => {
    const result = await storage.getEvents(50);
    res.json(result);
  });

  // Operations
  app.get("/api/scheduler/status", async (_req, res) => {
    const result = await storage.getSchedulerRuns();
    res.json(result);
  });

  app.get("/api/audit-logs", async (req, res) => {
    const limit = req.query.limit ? z.coerce.number().int().min(1).max(200).parse(req.query.limit) : 50;
    const result = await storage.getAuditLogs(limit);
    res.json(result);
  });

  app.post("/api/maintenance/retention/run", async (req, res) => {
    const { retentionDays } = retentionRunSchema.parse(req.body || {});
    const configuredDays = retentionDays
      ?? Number((await storage.getSettingValue("RETENTION_DAYS")) || process.env.RETENTION_DAYS || 90);
    const safeDays = Number.isInteger(configuredDays) && configuredDays > 0 ? configuredDays : 90;
    const result = await storage.purgeOldData(safeDays);
    res.json(result);
  });

  // Notification Routes
  app.get("/api/notification-routes", async (_req, res) => {
    const result = await storage.getNotificationRoutes();
    res.json(result);
  });

  app.post("/api/notification-routes", async (req, res) => {
    const { scopeType, scopeId, eventType, severityMin, recipientsJson } = notificationRouteCreateSchema.parse(req.body);
    if (scopeType === "CUSTOMER" && scopeId && !(await storage.getCustomer(scopeId))) {
      return res.status(404).json({ message: "Customer not found" });
    }
    if (scopeType === "JOB" && scopeId && !(await storage.getJob(scopeId))) {
      return res.status(404).json({ message: "Job not found" });
    }

    const result = await storage.createNotificationRoute({
      scopeType,
      scopeId: scopeId ?? null,
      eventType,
      severityMin,
      recipientsJson: recipientsJson.length > 0 ? recipientsJson : null,
    });
    res.status(201).json(result);
  });

  app.delete("/api/notification-routes/:id", async (req, res) => {
    const id = parseId(req.params.id);
    await storage.deleteNotificationRoute(id);
    res.status(204).send();
  });

  // Settings
  app.get("/api/settings", async (_req, res) => {
    const result = await storage.getSettings();
    res.json(result);
  });

  app.post("/api/settings", async (req, res) => {
    const { key, value } = settingSchema.parse(req.body);
    const result = await storage.upsertSetting(key, value || "");
    res.json(result);
  });

  app.post("/api/settings/test-imap", async (_req, res) => {
    await testImapConnection();
    res.json({ ok: true });
  });

  app.post("/api/settings/test-smtp", async (_req, res) => {
    await testSmtpConnection();
    res.json({ ok: true });
  });

  return httpServer;
}

export const routeInternals = {
  jobRuleCreateSchema,
  notificationRouteCreateSchema,
  settingSchema,
};
