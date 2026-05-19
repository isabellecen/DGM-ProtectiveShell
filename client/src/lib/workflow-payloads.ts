type OptionalSelectId = string | number | null | undefined;

function selectedId(value: OptionalSelectId): number | null {
  if (value == null || value === "" || value === "none") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function integerValue(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildLoginPayload(username: string, password: string) {
  return { username, password };
}

export type JobPayloadInput = {
  name: string;
  systemType: string;
  customerId?: OptionalSelectId;
  scheduleType: string;
  scheduleTime: string;
  windowHours: string | number;
  enabled: boolean;
  longRunning?: boolean;
  longWindowHours?: string | number;
  daysOfWeek?: string[];
};

export function buildJobPayload(input: JobPayloadInput) {
  const longRunning = input.longRunning ?? false;
  return {
    name: input.name,
    systemType: input.systemType,
    customerId: selectedId(input.customerId),
    scheduleType: input.scheduleType,
    scheduleTime: input.scheduleTime,
    windowHours: integerValue(input.windowHours, 6),
    enabled: input.enabled,
    longRunning,
    longWindowHours: longRunning ? integerValue(input.longWindowHours, 24) : undefined,
    daysOfWeek: input.scheduleType === "weekly" ? input.daysOfWeek ?? [] : [],
  };
}

export type ProxmoxHostPayloadInput = {
  name: string;
  host: string;
  port: string | number;
  username: string;
  password: string;
  hostKeyFingerprint?: string | null;
  allowInsecureHostKey: boolean;
  customerId?: OptionalSelectId;
  enabled: boolean;
};

export function buildProxmoxHostPayload(input: ProxmoxHostPayloadInput, isEditing: boolean) {
  const payload: Record<string, unknown> = {
    name: input.name,
    host: input.host,
    port: integerValue(input.port, 22),
    username: input.username,
    hostKeyFingerprint: input.hostKeyFingerprint || null,
    allowInsecureHostKey: input.allowInsecureHostKey,
    customerId: selectedId(input.customerId),
    enabled: input.enabled,
  };

  if (input.password || !isEditing) {
    payload.password = input.password;
  }

  return payload;
}

export type BackupTargetPayloadInput = {
  name: string;
  type: string;
  host: string;
  port: string | number;
  username: string;
  password: string;
  tlsFingerprint?: string | null;
  allowInsecureTls: boolean;
  customerId?: OptionalSelectId;
  enabled: boolean;
};

export function buildBackupTargetPayload(input: BackupTargetPayloadInput, isEditing: boolean) {
  const defaultPort = input.type === "PBS" ? 8007 : 5001;
  const payload: Record<string, unknown> = {
    name: input.name,
    type: input.type,
    host: input.host,
    port: integerValue(input.port, defaultPort),
    username: input.username,
    tlsFingerprint: input.tlsFingerprint || null,
    allowInsecureTls: input.allowInsecureTls,
    customerId: selectedId(input.customerId),
    enabled: input.enabled,
  };

  if (input.password || !isEditing) {
    payload.password = input.password;
  }

  return payload;
}

export function buildEmailLinkPayload(selectedJobId: OptionalSelectId) {
  return { jobId: selectedId(selectedJobId) };
}

export function buildEmailJobPayload(job: ReturnType<typeof buildJobPayload>, createRule: boolean) {
  return { job, createRule };
}

export function buildJobRulePayload(input: {
  jobId: number;
  senderMatch?: string | null;
  subjectMatch?: string | null;
  bodyMatch?: string | null;
  priority?: string | number;
}) {
  return {
    jobId: input.jobId,
    senderMatch: input.senderMatch || null,
    subjectMatch: input.subjectMatch || null,
    bodyMatch: input.bodyMatch || null,
    priority: integerValue(input.priority, 0),
  };
}

export function buildSettingPayload(key: string, value: string) {
  return { key, value };
}

export function buildRecipientPayload(input: {
  name: string;
  email: string;
  type: string;
  customerId?: OptionalSelectId;
  enabled: boolean;
}) {
  return {
    name: input.name,
    email: input.email,
    type: input.type,
    customerId: selectedId(input.customerId),
    enabled: input.enabled,
  };
}

export function buildNotificationRoutePayload(input: {
  scopeType: string;
  scopeId?: OptionalSelectId;
  eventType: string;
  severityMin: string;
  recipientIds: number[];
}) {
  return {
    scopeType: input.scopeType,
    scopeId: input.scopeType === "GLOBAL" ? null : selectedId(input.scopeId),
    eventType: input.eventType,
    severityMin: input.severityMin,
    recipientsJson: input.recipientIds,
  };
}
