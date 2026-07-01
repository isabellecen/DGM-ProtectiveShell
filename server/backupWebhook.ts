import crypto from "crypto";
import { z } from "zod";
import type { EmailEventStatus } from "./emailStatus";

export const BACKUP_WEBHOOK_PATH = "/api/integrations/backup/notifications";
export const PROXMOX_WEBHOOK_PATH = "/api/integrations/proxmox/notifications";
export const BACKUP_WEBHOOK_SECRET_SETTING = "BACKUP_WEBHOOK_SECRET";
export const PROXMOX_WEBHOOK_SECRET_SETTING = "PROXMOX_WEBHOOK_SECRET";

const pbsEventTypes = new Set(["sync", "prune", "verification", "tape-backup"]);
const DSM_FINGERPRINT_BUCKET_MS = 5 * 60 * 1000;

const proxmoxPayloadSchema = z.object({
  source: z.enum(["PVE", "PBS"]),
  severity: z.string().trim().min(1),
  timestamp: z.union([z.string(), z.number(), z.date()]),
  title: z.string().trim().nullable().optional(),
  message: z.string().trim().nullable().optional(),
  fields: z.record(z.unknown()).default({}),
}).passthrough();

export type BackupWebhookSource = "PVE" | "PBS" | "DSM";
export type ProxmoxWebhookSource = Extract<BackupWebhookSource, "PVE" | "PBS">;

export type NormalizedBackupWebhookEvent = {
  source: BackupWebhookSource;
  eventType: string;
  jobId: string;
  host: string | null;
  severity: string;
  status: EmailEventStatus;
  receivedAt: Date;
  title: string | null;
  message: string | null;
  fingerprint: string;
  payload: unknown;
};

export type NormalizedProxmoxWebhookEvent = NormalizedBackupWebhookEvent;

export type BackupWebhookParseResult =
  | { kind: "event"; event: NormalizedBackupWebhookEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; message: string };

export type ProxmoxWebhookParseResult = BackupWebhookParseResult;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function maybeJsonRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;

  if (typeof value !== "string" || !value.trim().startsWith("{")) {
    return null;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function fieldString(fields: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function bodyFieldString(body: Record<string, unknown>, names: string[]): string | null {
  const direct = fieldString(body, names);
  if (direct) return direct;

  const fields = maybeJsonRecord(body.fields);
  return fields ? fieldString(fields, names) : null;
}

function parseWebhookTimestamp(value: string | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const millis = Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") {
    return parseWebhookTimestamp(numeric);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWebhookSource(value: unknown): BackupWebhookSource | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "SYNOLOGY") return "DSM";
  if (normalized === "PVE" || normalized === "PBS" || normalized === "DSM") return normalized;
  return null;
}

export function statusFromProxmoxSeverity(severity: string): EmailEventStatus {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "error") return "FAIL";
  if (normalized === "warning") return "WARN";
  if (normalized === "info" || normalized === "notice") return "OK";
  return "UNKNOWN";
}

function statusFromDsmValue(value: string | null | undefined): EmailEventStatus {
  const normalized = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "UNKNOWN";

  if (/\b(fail|failed|failure|error|critical|unsuccessful|cancelled|canceled|aborted)\b/.test(normalized)) {
    return "FAIL";
  }
  if (/\b(warn|warning|attention|skipped|partial|suspended|interrupted)\b/.test(normalized)) {
    return "WARN";
  }
  if (/\b(ok|success|successful|successfully|succeeded|completed|complete|finished|normal)\b/.test(normalized)) {
    return "OK";
  }
  return "UNKNOWN";
}

function statusFromDsmPayload(input: {
  explicitStatus?: string | null;
  severity?: string | null;
  title?: string | null;
  message?: string | null;
}): EmailEventStatus {
  const explicit = statusFromDsmValue(input.explicitStatus);
  if (explicit !== "UNKNOWN") return explicit;

  const text = [input.title, input.message].filter(Boolean).join(" ");
  const textStatus = statusFromDsmValue(text);
  if (textStatus !== "UNKNOWN") return textStatus;

  const severity = input.severity?.trim().toLowerCase();
  if (severity === "error" || severity === "critical") return "FAIL";
  if (severity === "warning" || severity === "warn") return "WARN";
  return "UNKNOWN";
}

function supportedEventType(source: ProxmoxWebhookSource, eventType: string): boolean {
  if (source === "PVE") {
    return eventType === "vzdump";
  }
  return pbsEventTypes.has(eventType);
}

function fingerprintPart(value: string | null | undefined): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed.replace(/[^a-z0-9_.:-]+/g, "_") : "none";
}

function fingerprintTimestamp(value: Date, bucketMs?: number): string {
  if (!bucketMs) return value.toISOString();
  return new Date(Math.floor(value.getTime() / bucketMs) * bucketMs).toISOString();
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function payloadTextHash(...values: Array<string | null | undefined>): string | undefined {
  const text = values.filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
  return text ? shortHash(text) : undefined;
}

export function backupWebhookFingerprint(input: {
  source: BackupWebhookSource;
  eventType: string;
  jobId: string;
  host?: string | null;
  timestamp: Date;
  severity: string;
  contentHash?: string;
  timestampBucketMs?: number;
}) {
  const prefix = input.source === "DSM" ? "backup-webhook" : "proxmox-webhook";
  return [
    prefix,
    fingerprintPart(input.source),
    fingerprintPart(input.eventType),
    fingerprintPart(input.jobId),
    fingerprintPart(input.host),
    fingerprintTimestamp(input.timestamp, input.timestampBucketMs),
    fingerprintPart(input.severity),
    input.contentHash ? fingerprintPart(input.contentHash) : undefined,
  ].filter(Boolean).join(":");
}

export const proxmoxWebhookFingerprint = backupWebhookFingerprint;

function parseDsmTaskName(text: string): string | null {
  const patterns = [
    /\b(?:backup\s+)?task\s*['"]([^'"]+)['"]/i,
    /\b(?:backup\s+)?task\s*:\s*([^\r\n]+)/i,
    /\bhyper\s+backup\s+task\s+(.+?)\s+(?:on|completed|complete|failed|finished|succeeded|was|has|encountered|reported)\b/i,
    /\btask\s+(.+?)\s+(?:completed|complete|failed|finished|succeeded|was|has|encountered|reported)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern)?.[1]?.trim();
    if (match) {
      return match.replace(/\s+/g, " ").replace(/[.。]+$/, "").trim();
    }
  }

  return null;
}

function parseDsmHost(text: string): string | null {
  return text.match(/\[([^\]]+)\]/)?.[1]?.trim() || null;
}

function isDsmBackupNotification(input: {
  eventType: string;
  title?: string | null;
  message?: string | null;
}) {
  const text = [input.eventType, input.title, input.message].filter(Boolean).join(" ").toLowerCase();
  return /\bhyper\s+backup\b/.test(text) || /\bbackup\s+task\b/.test(text) || input.eventType.includes("backup");
}

function parseDsmWebhookPayload(
  body: Record<string, unknown>,
  now: Date,
): BackupWebhookParseResult {
  const eventType = (
    bodyFieldString(body, ["eventType", "event-type", "event_type", "type"]) || "hyper-backup"
  ).trim().toLowerCase();
  const title = bodyFieldString(body, ["title", "subject"]);
  const message = bodyFieldString(body, ["message", "text", "body", "content", "description"]);
  const combinedText = [title, message].filter(Boolean).join(" ");

  if (!isDsmBackupNotification({ eventType, title, message })) {
    return { kind: "ignored", reason: "non-backup DSM notification" };
  }

  const jobId =
    bodyFieldString(body, ["jobId", "job-id", "job_id", "jobid", "task", "taskName", "task-name", "task_name"]) ||
    parseDsmTaskName(combinedText);
  if (!jobId) {
    return { kind: "ignored", reason: "missing DSM task name" };
  }

  const host =
    bodyFieldString(body, ["hostname", "host", "nas", "server", "device", "node"]) ||
    parseDsmHost(combinedText);
  const severity = bodyFieldString(body, ["severity", "level"])?.toLowerCase() || "unknown";
  const explicitStatus = bodyFieldString(body, ["status", "result", "state"]);
  const status = statusFromDsmPayload({ explicitStatus, severity, title, message });
  const timestamp = bodyFieldString(body, ["timestamp", "time", "date", "receivedAt", "received_at"]);
  const parsedTimestamp = timestamp ? parseWebhookTimestamp(timestamp) : null;
  if (timestamp && !parsedTimestamp) {
    return { kind: "invalid", message: "timestamp is invalid" };
  }
  const receivedAt = parsedTimestamp || now;
  const contentHash = payloadTextHash(title, message, explicitStatus, jobId, host);

  return {
    kind: "event",
    event: {
      source: "DSM",
      eventType,
      jobId,
      host,
      severity,
      status,
      receivedAt,
      title,
      message,
      fingerprint: backupWebhookFingerprint({
        source: "DSM",
        eventType,
        jobId,
        host,
        timestamp: receivedAt,
        severity: status,
        contentHash,
        timestampBucketMs: parsedTimestamp ? undefined : DSM_FINGERPRINT_BUCKET_MS,
      }),
      payload: body,
    },
  };
}

function parseProxmoxPayload(value: unknown, source: ProxmoxWebhookSource): BackupWebhookParseResult {
  const parsed = proxmoxPayloadSchema.safeParse({
    ...(asRecord(value) || {}),
    source,
  });
  if (!parsed.success) {
    return {
      kind: "invalid",
      message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    };
  }

  const payload = parsed.data;
  const receivedAt = parseWebhookTimestamp(payload.timestamp);
  if (!receivedAt) {
    return { kind: "invalid", message: "timestamp is invalid" };
  }

  const eventType = fieldString(payload.fields, ["type", "event-type", "event_type"])?.toLowerCase();
  if (!eventType) {
    return { kind: "ignored", reason: "missing event type" };
  }

  if (!supportedEventType(payload.source, eventType)) {
    return { kind: "ignored", reason: `unsupported ${payload.source} event type: ${eventType}` };
  }

  const jobId = fieldString(payload.fields, ["job-id", "job_id", "jobid"]);
  if (!jobId) {
    return { kind: "ignored", reason: "missing job-id" };
  }

  const host = fieldString(payload.fields, ["hostname", "host", "node", "node-name", "node_name"]);
  const severity = payload.severity.trim().toLowerCase();

  return {
    kind: "event",
    event: {
      source: payload.source,
      eventType,
      jobId,
      host,
      severity,
      status: statusFromProxmoxSeverity(severity),
      receivedAt,
      title: payload.title || null,
      message: payload.message || null,
      fingerprint: backupWebhookFingerprint({
        source: payload.source,
        eventType,
        jobId,
        host,
        timestamp: receivedAt,
        severity,
      }),
      payload: value,
    },
  };
}

export function parseBackupWebhookPayload(value: unknown, now = new Date()): BackupWebhookParseResult {
  const body = asRecord(value);
  if (!body) {
    return { kind: "invalid", message: "body must be an object" };
  }

  const source = normalizeWebhookSource(body.source);
  if (!source) {
    return { kind: "invalid", message: "source must be PVE, PBS, DSM, or SYNOLOGY" };
  }

  if (source === "DSM") {
    return parseDsmWebhookPayload(body, now);
  }

  return parseProxmoxPayload(value, source);
}

export const parseProxmoxWebhookPayload = parseBackupWebhookPayload;

export function backupWebhookSecretFromHeaders(input: {
  authorization?: string;
  webhookSecret?: string;
  protectiveShellWebhookSecret?: string;
  genericWebhookSecret?: string;
}): string | undefined {
  const auth = input.authorization?.trim();
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  for (const value of [
    input.webhookSecret,
    input.protectiveShellWebhookSecret,
    input.genericWebhookSecret,
  ]) {
    const headerSecret = value?.trim();
    if (headerSecret) return headerSecret;
  }

  return undefined;
}

export const proxmoxWebhookSecretFromHeaders = backupWebhookSecretFromHeaders;

export function backupWebhookSecretMatches(provided: string | undefined, configured: string | undefined): boolean {
  if (!provided || !configured) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const configuredBuffer = Buffer.from(configured);
  return providedBuffer.length === configuredBuffer.length && crypto.timingSafeEqual(providedBuffer, configuredBuffer);
}

export const proxmoxWebhookSecretMatches = backupWebhookSecretMatches;

export const backupWebhookInternals = {
  fieldString,
  parseWebhookTimestamp,
  supportedEventType,
  normalizeWebhookSource,
  parseDsmTaskName,
  statusFromDsmValue,
};

export const proxmoxWebhookInternals = backupWebhookInternals;
