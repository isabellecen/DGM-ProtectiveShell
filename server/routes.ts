import type { Express, RequestHandler } from "express";
import type { Server } from "http";
import { storage, type IStorage } from "./storage";
import { pollBackupTargetAndPersist, runProxmoxHostCheck } from "./monitoring";
import { testImapConnection } from "./emailPoller";
import { testSmtpConnection } from "./notificationService";
import { assertMonitoredTargetAllowed } from "./egress";
import {
  parseBackupWebhookPayload,
  BACKUP_WEBHOOK_PATH,
  BACKUP_WEBHOOK_SECRET_SETTING,
  PROXMOX_WEBHOOK_PATH,
  PROXMOX_WEBHOOK_SECRET_SETTING,
  backupWebhookSecretFromHeaders,
  backupWebhookSecretMatches,
} from "./backupWebhook";
import { z } from "zod";

const idParamSchema = z.coerce.number().int().positive();
const nullableIdSchema = z.union([z.coerce.number().int().positive(), z.null()]);
const systemTypeSchema = z.enum(["VEEAM", "PBS", "SYNOLOGY"]);
const webhookSourceSchema = z.enum(["PVE", "PBS", "DSM"]);
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
  "BACKUP_WEBHOOK_SECRET",
  "PROXMOX_WEBHOOK_SECRET",
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
  webhookSource: z.union([webhookSourceSchema, z.null()]).optional(),
  webhookJobId: z.string().trim().max(255).nullable().optional(),
  webhookHost: z.string().trim().max(255).nullable().optional(),
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

  if (data.key === "SMTP_FROM" && !z.string().email().safeParse(value).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "SMTP_FROM must be a valid email address",
    });
  }
});

const emailCreateJobSchema = z.object({
  job: jobCreateSchema,
  createRule: z.boolean().default(false),
}).strict();

const notificationRouteCreateSchema = z.object({
  scopeType: z.enum(["GLOBAL", "CUSTOMER", "JOB"]).default("GLOBAL"),
  scopeId: nullableIdSchema.optional(),
  eventType: z.enum(["FAIL", "MISSING", "WARN", "DAILY_REPORT", "MONITOR_DOWN"]),
  severityMin: z.enum(["INFO", "WARN", "CRIT"]).default("WARN"),
  recipientsJson: z.array(idParamSchema).min(1, "Select at least one recipient"),
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
const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

function parseId(value: unknown) {
  return idParamSchema.parse(value);
}

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function notFound(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 404;
  return err;
}

async function assertCustomerReferenceExists(customerId?: number | null) {
  if (customerId == null) {
    return;
  }
  if (!(await storage.getCustomer(customerId))) {
    throw notFound("Customer not found");
  }
}

function assertJobPatchScheduleValid(
  existing: { scheduleType: string; daysOfWeek?: string[] | null },
  data: { scheduleType?: string; daysOfWeek?: string[] | null },
) {
  const scheduleType = data.scheduleType ?? existing.scheduleType;
  const daysOfWeek = data.daysOfWeek ?? existing.daysOfWeek ?? [];
  if (scheduleType === "weekly" && daysOfWeek.length === 0) {
    throw badRequest("Select at least one weekday for weekly jobs");
  }
}

function normalizeJobCreateData<T extends {
  webhookSource?: "PVE" | "PBS" | "DSM" | null;
  webhookJobId?: string | null;
  webhookHost?: string | null;
}>(data: T): T & { webhookSource: "PVE" | "PBS" | "DSM" | null; webhookJobId: string | null; webhookHost: string | null } {
  const webhookSource = data.webhookSource ?? null;
  return {
    ...data,
    webhookSource,
    webhookJobId: webhookSource ? data.webhookJobId?.trim() || null : null,
    webhookHost: webhookSource ? data.webhookHost?.trim() || null : null,
  };
}

function normalizeJobPatchData<T extends {
  webhookSource?: "PVE" | "PBS" | "DSM" | null;
  webhookJobId?: string | null;
  webhookHost?: string | null;
}>(data: T): T {
  const normalized = { ...data };
  if ("webhookSource" in normalized && normalized.webhookSource == null) {
    normalized.webhookSource = null;
    normalized.webhookJobId = null;
    normalized.webhookHost = null;
    return normalized;
  }
  if ("webhookJobId" in normalized) {
    normalized.webhookJobId = normalized.webhookJobId?.trim() || null;
  }
  if ("webhookHost" in normalized) {
    normalized.webhookHost = normalized.webhookHost?.trim() || null;
  }
  return normalized;
}

function assertJobWebhookMappingValid(
  existing: { webhookSource?: string | null; webhookJobId?: string | null },
  data: { webhookSource?: string | null; webhookJobId?: string | null },
) {
  const webhookSource = data.webhookSource === undefined ? existing.webhookSource : data.webhookSource;
  const webhookJobId = data.webhookJobId === undefined ? existing.webhookJobId : data.webhookJobId;
  if (webhookSource && !webhookJobId?.trim()) {
    throw badRequest("Webhook job ID is required when a webhook source is selected");
  }
}

function defaultBackupTargetPort(type: z.infer<typeof backupTargetTypeSchema>): number {
  return type === "PBS" ? 8007 : 5001;
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

async function assertTargetHostAllowed(host: string) {
  try {
    await assertMonitoredTargetAllowed(host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw badRequest(message);
  }
}

async function assertRecipientsExist(recipientIds: number[]) {
  const missing: number[] = [];
  const disabled: number[] = [];
  for (const id of recipientIds) {
    const recipient = await storage.getRecipient(id);
    if (!recipient) {
      missing.push(id);
    } else if (!recipient.enabled) {
      disabled.push(id);
    }
  }

  if (missing.length > 0) {
    throw badRequest(`Unknown recipient id(s): ${missing.join(", ")}`);
  }
  if (disabled.length > 0) {
    throw badRequest(`Disabled recipient id(s) cannot be used in routes: ${disabled.join(", ")}`);
  }
}

type BackupWebhookStorage =
  Pick<IStorage, "getSettingValue"> &
  Partial<Pick<IStorage, "ingestBackupWebhookEvent" | "ingestProxmoxWebhookEvent" | "createAuditLog">>;

function webhookBodyField(body: unknown, names: string[]): string | null {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (!record) {
    return null;
  }

  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }

  const fields = record.fields;
  let fieldsRecord: Record<string, unknown> | null =
    fields && typeof fields === "object" && !Array.isArray(fields) ? fields as Record<string, unknown> : null;
  if (!fieldsRecord && typeof fields === "string" && fields.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(fields);
      fieldsRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      fieldsRecord = null;
    }
  }
  if (!fieldsRecord) {
    return null;
  }

  for (const name of names) {
    const value = fieldsRecord[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }

  return null;
}

function webhookBodySource(body: unknown): string | null {
  const source = body && typeof body === "object" ? (body as { source?: unknown }).source : undefined;
  if (typeof source !== "string" || !source.trim()) return null;
  const normalized = source.trim().toUpperCase();
  return normalized === "SYNOLOGY" ? "DSM" : normalized;
}

function summarizeWebhookIdentity(input: {
  source?: string | null;
  jobId?: string | null;
  host?: string | null;
}) {
  return [
    `source=${input.source || "unknown"}`,
    `job-id=${input.jobId || "unknown"}`,
    `host=${input.host || "none"}`,
  ].join(" ");
}

function auditIgnoredBackupWebhook(
  webhookStorage: BackupWebhookStorage,
  input: {
    reason: string;
    source?: string | null;
    jobId?: string | null;
    host?: string | null;
    payload?: unknown;
  },
) {
  if (!webhookStorage.createAuditLog) {
    return;
  }

  const identity = summarizeWebhookIdentity(input);
  void webhookStorage.createAuditLog({
    actor: "system",
    action: "ignore",
    entityType: "backup-webhook",
    summary: `Ignored backup webhook: ${input.reason} (${identity})`,
    metadataJson: {
      reason: input.reason,
      source: input.source || null,
      jobId: input.jobId || null,
      host: input.host || null,
      payload: input.payload,
    },
  }).catch((err) => {
    console.warn("Backup webhook audit log write failed:", err);
  });
}

function auditProcessedBackupWebhook(
  webhookStorage: BackupWebhookStorage,
  input: {
    source?: string | null;
    jobId?: string | null;
    host?: string | null;
    matchedJobId: number;
    eventId: number;
    expectedRunId: number | null;
    expectedRunLinkReason?: string;
    eventStatus: string;
    duplicate: boolean;
    payload?: unknown;
  },
) {
  if (!webhookStorage.createAuditLog) {
    return;
  }

  const identity = summarizeWebhookIdentity(input);
  const expectedRun = input.expectedRunId ? `expected-run=#${input.expectedRunId}` : "expected-run=none";
  const runLinkReason = input.expectedRunLinkReason ? ` run-link=${input.expectedRunLinkReason}` : "";
  void webhookStorage.createAuditLog({
    actor: "system",
    action: "process",
    entityType: "backup-webhook",
    entityId: String(input.eventId),
    summary: `Processed backup webhook: status=${input.eventStatus} job=#${input.matchedJobId} ${expectedRun}${runLinkReason} duplicate=${input.duplicate ? "yes" : "no"} (${identity})`,
    metadataJson: {
      source: input.source || null,
      jobId: input.jobId || null,
      host: input.host || null,
      matchedJobId: input.matchedJobId,
      eventId: input.eventId,
      expectedRunId: input.expectedRunId,
      expectedRunLinkReason: input.expectedRunLinkReason || null,
      eventStatus: input.eventStatus,
      duplicate: input.duplicate,
      payload: input.payload,
    },
  }).catch((err) => {
    console.warn("Backup webhook audit log write failed:", err);
  });
}

export function createBackupWebhookHandler(webhookStorage: BackupWebhookStorage = storage): RequestHandler {
  return async (req, res) => {
    const configuredSecret =
      (await webhookStorage.getSettingValue(BACKUP_WEBHOOK_SECRET_SETTING)) ||
      process.env.BACKUP_WEBHOOK_SECRET ||
      (await webhookStorage.getSettingValue(PROXMOX_WEBHOOK_SECRET_SETTING)) ||
      process.env.PROXMOX_WEBHOOK_SECRET;

    const providedSecret = backupWebhookSecretFromHeaders({
      authorization: req.get("authorization"),
      webhookSecret: req.get("x-secureshell-webhook-secret"),
      protectiveShellWebhookSecret: req.get("x-protectiveshell-webhook-secret"),
      genericWebhookSecret: req.get("x-webhook-secret"),
    });
    if (!backupWebhookSecretMatches(providedSecret, configuredSecret)) {
      return res.status(401).json({ message: "Invalid webhook secret" });
    }

    const parsed = parseBackupWebhookPayload(req.body);
    if (parsed.kind === "invalid") {
      return res.status(400).json({ message: parsed.message });
    }
    if (parsed.kind === "ignored") {
      auditIgnoredBackupWebhook(webhookStorage, {
        reason: parsed.reason,
        source: webhookBodySource(req.body),
        jobId: webhookBodyField(req.body, ["jobId", "job-id", "job_id", "jobid", "task", "taskName"]),
        host: webhookBodyField(req.body, ["hostname", "host", "node", "node-name", "node_name"]),
        payload: req.body,
      });
      return res.status(202).json({ ok: true, ignored: true, reason: parsed.reason });
    }

    const result = webhookStorage.ingestBackupWebhookEvent
      ? await webhookStorage.ingestBackupWebhookEvent(parsed.event)
      : await webhookStorage.ingestProxmoxWebhookEvent?.(parsed.event);
    if (!result) {
      throw new Error("Backup webhook ingestion is not configured");
    }
    if (result.status === "ignored") {
      auditIgnoredBackupWebhook(webhookStorage, {
        reason: result.reason,
        source: parsed.event.source,
        jobId: parsed.event.jobId,
        host: parsed.event.host,
        payload: parsed.event.payload,
      });
      return res.status(202).json({ ok: true, ignored: true, reason: result.reason });
    }

    auditProcessedBackupWebhook(webhookStorage, {
      source: parsed.event.source,
      jobId: parsed.event.jobId,
      host: parsed.event.host,
      matchedJobId: result.jobId,
      eventId: result.eventId,
      expectedRunId: result.expectedRunId,
      expectedRunLinkReason: result.expectedRunLinkReason,
      eventStatus: result.eventStatus,
      duplicate: result.duplicate,
      payload: parsed.event.payload,
    });
    return res.json({ ok: true, ...result });
  };
}

export const createProxmoxWebhookHandler = createBackupWebhookHandler;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.post(BACKUP_WEBHOOK_PATH, createBackupWebhookHandler());
  app.post(PROXMOX_WEBHOOK_PATH, createBackupWebhookHandler());

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
    const normalizedData = normalizeJobCreateData(data);
    assertJobWebhookMappingValid({}, normalizedData);
    await assertCustomerReferenceExists(normalizedData.customerId);
    const result = await storage.createJob({
      ...normalizedData,
      customerId: normalizedData.customerId ?? null,
    });
    res.status(201).json(result);
  });

  app.patch("/api/jobs/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const data = normalizeJobPatchData(jobPatchSchema.parse(req.body));
    const existing = await storage.getJob(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    assertJobPatchScheduleValid(existing, data);
    assertJobWebhookMappingValid(existing, data);
    await assertCustomerReferenceExists(data.customerId);
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
    const host = await storage.getProxmoxHostWithCustomer(id);
    if (!host) return res.status(404).json({ message: "Not found" });
    res.json({ ...host, password: "***" });
  });

  app.post("/api/proxmox-hosts", async (req, res) => {
    const data = proxmoxHostCreateSchema.parse(req.body);
    assertInsecureTargetAllowed("SSH host key", data.allowInsecureHostKey);
    await assertCustomerReferenceExists(data.customerId);
    await assertTargetHostAllowed(data.host);
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
    await assertCustomerReferenceExists(updateData.customerId);
    if (updateData.host) {
      await assertTargetHostAllowed(updateData.host);
    }

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
    const target = await storage.getBackupTargetWithCustomer(id);
    if (!target) return res.status(404).json({ message: "Not found" });
    res.json({ ...target, password: "***" });
  });

  app.post("/api/backup-targets", async (req, res) => {
    const data = backupTargetCreateSchema.parse(req.body);
    assertInsecureTargetAllowed("target TLS", data.allowInsecureTls);
    await assertCustomerReferenceExists(data.customerId);
    await assertTargetHostAllowed(data.host);
    const result = await storage.createBackupTarget({
      ...data,
      port: data.port || defaultBackupTargetPort(data.type),
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
    await assertCustomerReferenceExists(updateData.customerId);
    if (updateData.host) {
      await assertTargetHostAllowed(updateData.host);
    }
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
    const withCustomer = await storage.getBackupTargetWithCustomer(id);
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
    await assertCustomerReferenceExists(customerId);
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
    await assertCustomerReferenceExists(data.customerId);
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
    const { limit, offset } = paginationQuerySchema.parse(_req.query);
    const result = await storage.getUnmatchedEmails(limit, offset);
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

  app.get("/api/emails/ingestion-failures", async (req, res) => {
    const { limit, offset } = paginationQuerySchema.parse(req.query);
    const result = await storage.getEmailIngestionFailures(limit, offset);
    res.json(result);
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

  app.post("/api/emails/:id/create-job", async (req, res) => {
    const emailId = parseId(req.params.id);
    const { job, createRule } = emailCreateJobSchema.parse(req.body);
    await assertCustomerReferenceExists(job.customerId);
    const result = await storage.createJobFromEmail(
      emailId,
      {
        ...job,
        customerId: job.customerId ?? null,
      },
      { createRule },
    );
    if (!result) {
      return res.status(404).json({ message: "Email not found" });
    }
    res.status(201).json(result);
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
    await assertRecipientsExist(recipientsJson);

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
  assertCustomerReferenceExists,
  jobRuleCreateSchema,
  emailCreateJobSchema,
  notificationRouteCreateSchema,
  settingSchema,
  paginationQuerySchema,
  assertRecipientsExist,
  assertJobPatchScheduleValid,
  assertJobWebhookMappingValid,
  normalizeJobCreateData,
  normalizeJobPatchData,
  defaultBackupTargetPort,
};
