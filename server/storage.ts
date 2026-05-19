import { db } from "./db";
import { eq, desc, sql, and, count, lt, ne, gte, lte } from "drizzle-orm";
import {
  customers, insertCustomerSchema, type Customer, type InsertCustomer,
  jobs, type Job, type InsertJob,
  jobRules, type JobRule, type InsertJobRule,
  expectedRuns, type ExpectedRun, type InsertExpectedRun,
  emails, type Email, type InsertEmail,
  events, type Event, type InsertEvent,
  incidents, type Incident, type InsertIncident,
  recipients, type Recipient, type InsertRecipient,
  notificationRoutes, type NotificationRoute, type InsertNotificationRoute,
  proxmoxHosts, type ProxmoxHost, type InsertProxmoxHost,
  proxmoxChecks, type ProxmoxCheck, type InsertProxmoxCheck,
  backupTargets, type BackupTarget, type InsertBackupTarget,
  appSettings, type AppSetting, type InsertAppSetting,
  schedulerRuns, type SchedulerRun,
  auditLogs, type AuditLog, type InsertAuditLog,
  rateLimitHits,
} from "@shared/schema";
import { CLEAR_SECRET_SETTING_VALUE } from "@shared/settings";
import { decryptSecret, encryptSecret, isSecretSettingKey } from "./crypto";
import { detectEventStatus } from "./emailStatus";
import { backupEmailIncidentFingerprint, syncBackupEmailIncident } from "./backupIncidents";

type WithCustomerName = { customerName?: string | null };
type WithJobName = { jobName?: string | null };

export interface IStorage {
  getCustomers(): Promise<Customer[]>;
  getCustomer(id: number): Promise<Customer | undefined>;
  createCustomer(data: InsertCustomer): Promise<Customer>;
  updateCustomer(id: number, data: Partial<InsertCustomer>): Promise<Customer | undefined>;
  deleteCustomer(id: number): Promise<void>;

  getJobs(): Promise<(Job & WithCustomerName)[]>;
  getJob(id: number): Promise<Job | undefined>;
  createJob(data: InsertJob): Promise<Job>;
  createJobFromEmail(
    emailId: number,
    data: InsertJob,
    options?: { createRule?: boolean },
  ): Promise<CreateJobFromEmailResult | undefined>;
  updateJob(id: number, data: Partial<InsertJob>): Promise<Job | undefined>;
  deleteJob(id: number): Promise<void>;

  getProxmoxHosts(): Promise<(ProxmoxHost & WithCustomerName)[]>;
  getProxmoxHost(id: number): Promise<ProxmoxHost | undefined>;
  getProxmoxHostWithCustomer(id: number): Promise<(ProxmoxHost & WithCustomerName) | undefined>;
  createProxmoxHost(data: InsertProxmoxHost): Promise<ProxmoxHost>;
  updateProxmoxHost(id: number, data: ProxmoxHostUpdate): Promise<ProxmoxHost | undefined>;
  deleteProxmoxHost(id: number): Promise<void>;

  getIncidents(): Promise<Incident[]>;
  getIncident(id: number): Promise<Incident | undefined>;
  createIncident(data: InsertIncident): Promise<Incident>;
  updateIncidentState(id: number, state: string): Promise<Incident | undefined>;

  getRecipients(): Promise<Recipient[]>;
  getRecipient(id: number): Promise<Recipient | undefined>;
  createRecipient(data: InsertRecipient): Promise<Recipient>;
  updateRecipient(id: number, data: Partial<InsertRecipient>): Promise<Recipient | undefined>;
  deleteRecipient(id: number): Promise<void>;

  getSettings(): Promise<AppSetting[]>;
  getSettingValue(key: string): Promise<string | undefined>;
  upsertSetting(key: string, value: string): Promise<AppSetting>;

  getExpectedRuns(limit?: number): Promise<(ExpectedRun & WithJobName)[]>;

  getJobRules(jobId?: number): Promise<JobRule[]>;
  createJobRule(data: InsertJobRule): Promise<JobRule>;
  deleteJobRule(id: number): Promise<void>;

  getEmails(limit?: number): Promise<Email[]>;
  getUnmatchedEmails(): Promise<Email[]>;
  getMatchedEmails(limit?: number): Promise<(Email & WithJobName)[]>;
  getEmail(id: number): Promise<Email | undefined>;
  linkEmailToJob(emailId: number, jobId: number): Promise<Email | undefined>;
  getUnmatchedEmailCount(): Promise<number>;
  getEvents(limit?: number): Promise<(Event & WithJobName)[]>;

  getProxmoxChecks(hostId: number, limit?: number): Promise<ProxmoxCheck[]>;
  createProxmoxCheck(data: InsertProxmoxCheck): Promise<ProxmoxCheck>;

  getBackupTargets(): Promise<(BackupTarget & WithCustomerName)[]>;
  getBackupTarget(id: number): Promise<BackupTarget | undefined>;
  getBackupTargetWithCustomer(id: number): Promise<(BackupTarget & WithCustomerName) | undefined>;
  createBackupTarget(data: InsertBackupTarget): Promise<BackupTarget>;
  updateBackupTarget(id: number, data: BackupTargetUpdate): Promise<BackupTarget | undefined>;
  deleteBackupTarget(id: number): Promise<void>;

  getNotificationRoutes(): Promise<NotificationRoute[]>;
  createNotificationRoute(data: InsertNotificationRoute): Promise<NotificationRoute>;
  deleteNotificationRoute(id: number): Promise<void>;

  getSchedulerRuns(): Promise<SchedulerRun[]>;
  getAuditLogs(limit?: number): Promise<AuditLog[]>;
  createAuditLog(data: InsertAuditLog): Promise<AuditLog>;
  purgeOldData(retentionDays: number): Promise<RetentionSummary>;

  getDashboardStats(): Promise<{
    totalJobs: number;
    enabledJobs: number;
    totalHosts: number;
    openIncidents: number;
    recentRuns: (ExpectedRun & WithJobName)[];
    recentIncidents: Incident[];
    hostStatuses: { status: string; count: number }[];
    jobsBySystem: { systemType: string; count: number }[];
  }>;
}

export type RetentionSummary = {
  cutoff: Date;
  deletedEvents: number;
  deletedExpectedRuns: number;
  deletedEmails: number;
  deletedProxmoxChecks: number;
  deletedIncidents: number;
};

export type CreateJobFromEmailResult = {
  job: Job;
  email: Email;
  rule?: JobRule;
};

type ProxmoxHostUpdate = Partial<InsertProxmoxHost> & {
  lastCheckAt?: Date;
  lastStatus?: string | null;
  lastStatusDetails?: unknown;
  consecutiveFailures?: number;
};

type BackupTargetUpdate = Partial<InsertBackupTarget> & {
  totalBytes?: string | null;
  usedBytes?: string | null;
  lastPolledAt?: Date;
  pollStatus?: string | null;
  pollError?: string | null;
  datastoresJson?: unknown;
};

const prunedRecipient = Symbol("prunedRecipient");

function pruneRecipientFromRoutePayload(value: unknown, recipientId: number): unknown | typeof prunedRecipient {
  if (typeof value === "number") {
    return value === recipientId ? prunedRecipient : value;
  }

  if (typeof value === "string") {
    return /^\d+$/.test(value) && Number(value) === recipientId ? prunedRecipient : value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneRecipientFromRoutePayload(entry, recipientId))
      .filter((entry) => entry !== prunedRecipient);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, pruneRecipientFromRoutePayload(entry, recipientId)] as const)
      .filter(([, entry]) => entry !== prunedRecipient);
    return entries.length > 0 ? Object.fromEntries(entries) : prunedRecipient;
  }

  return value;
}

function routePayloadHasRecipients(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => routePayloadHasRecipients(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => routePayloadHasRecipients(entry));
  }
  return value != null && value !== "";
}

function shouldPruneRecipientRoutesForUpdate(data: Partial<InsertRecipient>): boolean {
  return data.enabled === false;
}

async function pruneRecipientFromNotificationRoutes(client: typeof db, recipientId: number): Promise<void> {
  const routes = await client.select().from(notificationRoutes);
  for (const route of routes) {
    const nextPayload = pruneRecipientFromRoutePayload(route.recipientsJson, recipientId);
    if (nextPayload === prunedRecipient || !routePayloadHasRecipients(nextPayload)) {
      await client.delete(notificationRoutes).where(eq(notificationRoutes.id, route.id));
    } else if (JSON.stringify(nextPayload) !== JSON.stringify(route.recipientsJson)) {
      await client
        .update(notificationRoutes)
        .set({ recipientsJson: nextPayload })
        .where(eq(notificationRoutes.id, route.id));
    }
  }
}

async function linkEmailToJobInTransaction(
  client: typeof db,
  emailId: number,
  jobId: number,
  preloadedEmail?: Email,
): Promise<Email | undefined> {
  const email = preloadedEmail ?? (await client.select().from(emails).where(eq(emails.id, emailId)))[0];
  if (!email) {
    return undefined;
  }

  const receivedAt = email.receivedAt || new Date();
  const status = detectEventStatus(`${email.subject || ""}\n${email.snippet || ""}`);
  const [run] = await client
    .select()
    .from(expectedRuns)
    .where(
      and(
        eq(expectedRuns.jobId, jobId),
        eq(expectedRuns.status, "PENDING"),
        lte(expectedRuns.scheduledFor, receivedAt),
        gte(expectedRuns.deadlineAt, receivedAt),
      ),
    )
    .orderBy(desc(expectedRuns.scheduledFor))
    .limit(1);
  const [job] = await client.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) {
    return undefined;
  }

  const nextExpectedRunId = run?.id ?? null;
  const [existingEvent] = await client.select().from(events).where(eq(events.emailId, emailId)).limit(1);
  if (existingEvent) {
    const previousExpectedRunId = existingEvent.expectedRunId;
    const previousFingerprint = backupEmailIncidentFingerprint({
      emailId,
      expectedRunId: previousExpectedRunId,
    });
    const nextFingerprint = backupEmailIncidentFingerprint({
      emailId,
      expectedRunId: nextExpectedRunId,
    });

    if (previousExpectedRunId && previousExpectedRunId !== nextExpectedRunId) {
      await client
        .update(expectedRuns)
        .set({ status: "PENDING", linkedEventId: null })
        .where(
          and(
            eq(expectedRuns.id, previousExpectedRunId),
            eq(expectedRuns.linkedEventId, existingEvent.id),
          ),
        );
    }

    if (previousFingerprint !== nextFingerprint) {
      await client
        .update(incidents)
        .set({ state: "RESOLVED", updatedAt: new Date() })
        .where(eq(incidents.sourceFingerprint, previousFingerprint));
    }
  }

  const [event] = existingEvent
    ? await client
        .update(events)
        .set({
          jobId,
          expectedRunId: nextExpectedRunId,
          status,
          receivedAt,
        })
        .where(eq(events.id, existingEvent.id))
        .returning()
    : await client
        .insert(events)
        .values({
          jobId,
          expectedRunId: nextExpectedRunId,
          status,
          receivedAt,
          emailId,
        })
        .returning();

  const [result] = await client
    .update(emails)
    .set({ matchedJobId: jobId, ingestedOk: true })
    .where(eq(emails.id, emailId))
    .returning();

  if (run && status !== "UNKNOWN") {
    await client
      .update(expectedRuns)
      .set({ status, linkedEventId: event.id })
      .where(eq(expectedRuns.id, run.id));
  }

  await syncBackupEmailIncident({
    client: client as unknown as Parameters<typeof syncBackupEmailIncident>[0]["client"],
    jobId,
    jobName: job?.name,
    emailId,
    expectedRunId: nextExpectedRunId,
    status,
    receivedAt,
    subject: email.subject,
    snippet: email.snippet,
  });

  return result;
}

export class DatabaseStorage implements IStorage {
  private decryptProxmoxHost<T extends { password: string }>(host: T): T {
    return { ...host, password: decryptSecret(host.password) || "" };
  }

  private decryptBackupTarget<T extends { password: string }>(target: T): T {
    return { ...target, password: decryptSecret(target.password) || "" };
  }

  async getCustomers(): Promise<Customer[]> {
    return db.select().from(customers);
  }

  async getCustomer(id: number): Promise<Customer | undefined> {
    const [result] = await db.select().from(customers).where(eq(customers.id, id));
    return result;
  }

  async createCustomer(data: InsertCustomer): Promise<Customer> {
    const [result] = await db.insert(customers).values(data).returning();
    return result;
  }

  async updateCustomer(id: number, data: Partial<InsertCustomer>): Promise<Customer | undefined> {
    const [result] = await db.update(customers).set(data).where(eq(customers.id, id)).returning();
    return result;
  }

  async deleteCustomer(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(jobs).set({ customerId: null }).where(eq(jobs.customerId, id));
      await tx.update(recipients).set({ customerId: null }).where(eq(recipients.customerId, id));
      await tx.update(proxmoxHosts).set({ customerId: null }).where(eq(proxmoxHosts.customerId, id));
      await tx.update(backupTargets).set({ customerId: null }).where(eq(backupTargets.customerId, id));
      await tx.delete(customers).where(eq(customers.id, id));
    });
  }

  async getJobs(): Promise<(Job & WithCustomerName)[]> {
    const result = await db
      .select({
        id: jobs.id,
        customerId: jobs.customerId,
        name: jobs.name,
        systemType: jobs.systemType,
        scheduleType: jobs.scheduleType,
        scheduleTime: jobs.scheduleTime,
        daysOfWeek: jobs.daysOfWeek,
        windowHours: jobs.windowHours,
        longRunning: jobs.longRunning,
        longWindowHours: jobs.longWindowHours,
        enabled: jobs.enabled,
        customerName: customers.name,
      })
      .from(jobs)
      .leftJoin(customers, eq(jobs.customerId, customers.id));
    return result;
  }

  async getJob(id: number): Promise<Job | undefined> {
    const [result] = await db.select().from(jobs).where(eq(jobs.id, id));
    return result;
  }

  async createJob(data: InsertJob): Promise<Job> {
    const [result] = await db.insert(jobs).values(data).returning();
    return result;
  }

  async createJobFromEmail(
    emailId: number,
    data: InsertJob,
    options: { createRule?: boolean } = {},
  ): Promise<CreateJobFromEmailResult | undefined> {
    return db.transaction(async (tx) => {
      const [email] = await tx.select().from(emails).where(eq(emails.id, emailId));
      if (!email) {
        return undefined;
      }

      const [job] = await tx.insert(jobs).values(data).returning();
      const linkedEmail = await linkEmailToJobInTransaction(tx as unknown as typeof db, emailId, job.id, email);
      if (!linkedEmail) {
        throw new Error("Created job could not be linked to email");
      }

      let rule: JobRule | undefined;
      if (options.createRule && email.fromAddr) {
        [rule] = await tx
          .insert(jobRules)
          .values({
            jobId: job.id,
            senderMatch: email.fromAddr,
            subjectMatch: null,
            bodyMatch: null,
            priority: 0,
          })
          .returning();
      }

      return { job, email: linkedEmail, rule };
    });
  }

  async updateJob(id: number, data: Partial<InsertJob>): Promise<Job | undefined> {
    const [result] = await db.update(jobs).set(data).where(eq(jobs.id, id)).returning();
    return result;
  }

  async deleteJob(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(incidents)
        .set({ state: "RESOLVED", updatedAt: new Date() })
        .where(and(eq(incidents.sourceType, "BACKUP"), eq(incidents.sourceId, id), ne(incidents.state, "RESOLVED")));
      await tx.update(emails).set({ matchedJobId: null, ingestedOk: false }).where(eq(emails.matchedJobId, id));
      await tx.delete(events).where(eq(events.jobId, id));
      await tx.delete(expectedRuns).where(eq(expectedRuns.jobId, id));
      await tx.delete(jobRules).where(eq(jobRules.jobId, id));
      await tx.delete(jobs).where(eq(jobs.id, id));
    });
  }

  async getProxmoxHosts(): Promise<(ProxmoxHost & WithCustomerName)[]> {
    const result = await db
      .select({
        id: proxmoxHosts.id,
        customerId: proxmoxHosts.customerId,
        name: proxmoxHosts.name,
        host: proxmoxHosts.host,
        port: proxmoxHosts.port,
        username: proxmoxHosts.username,
        password: proxmoxHosts.password,
        hostKeyFingerprint: proxmoxHosts.hostKeyFingerprint,
        allowInsecureHostKey: proxmoxHosts.allowInsecureHostKey,
        enabled: proxmoxHosts.enabled,
        lastCheckAt: proxmoxHosts.lastCheckAt,
        lastStatus: proxmoxHosts.lastStatus,
        lastStatusDetails: proxmoxHosts.lastStatusDetails,
        consecutiveFailures: proxmoxHosts.consecutiveFailures,
        customerName: customers.name,
      })
      .from(proxmoxHosts)
      .leftJoin(customers, eq(proxmoxHosts.customerId, customers.id));
    return result.map((host) => this.decryptProxmoxHost(host));
  }

  async getProxmoxHost(id: number): Promise<ProxmoxHost | undefined> {
    const [result] = await db.select().from(proxmoxHosts).where(eq(proxmoxHosts.id, id));
    return result ? this.decryptProxmoxHost(result) : undefined;
  }

  async getProxmoxHostWithCustomer(id: number): Promise<(ProxmoxHost & WithCustomerName) | undefined> {
    const [result] = await db
      .select({
        id: proxmoxHosts.id,
        customerId: proxmoxHosts.customerId,
        name: proxmoxHosts.name,
        host: proxmoxHosts.host,
        port: proxmoxHosts.port,
        username: proxmoxHosts.username,
        password: proxmoxHosts.password,
        hostKeyFingerprint: proxmoxHosts.hostKeyFingerprint,
        allowInsecureHostKey: proxmoxHosts.allowInsecureHostKey,
        enabled: proxmoxHosts.enabled,
        lastCheckAt: proxmoxHosts.lastCheckAt,
        lastStatus: proxmoxHosts.lastStatus,
        lastStatusDetails: proxmoxHosts.lastStatusDetails,
        consecutiveFailures: proxmoxHosts.consecutiveFailures,
        customerName: customers.name,
      })
      .from(proxmoxHosts)
      .leftJoin(customers, eq(proxmoxHosts.customerId, customers.id))
      .where(eq(proxmoxHosts.id, id));
    return result ? this.decryptProxmoxHost(result) : undefined;
  }

  async createProxmoxHost(data: InsertProxmoxHost): Promise<ProxmoxHost> {
    const [result] = await db.insert(proxmoxHosts).values({
      ...data,
      password: encryptSecret(data.password) || "",
    }).returning();
    return this.decryptProxmoxHost(result);
  }

  async updateProxmoxHost(id: number, data: ProxmoxHostUpdate): Promise<ProxmoxHost | undefined> {
    const updateData: ProxmoxHostUpdate = { ...data };
    if (typeof data.password === "string") {
      updateData.password = encryptSecret(data.password) || "";
    }
    const [result] = await db.update(proxmoxHosts).set(updateData).where(eq(proxmoxHosts.id, id)).returning();
    return result ? this.decryptProxmoxHost(result) : undefined;
  }

  async deleteProxmoxHost(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(incidents)
        .set({ state: "RESOLVED", updatedAt: new Date() })
        .where(and(eq(incidents.sourceType, "PROXMOX"), eq(incidents.sourceId, id), ne(incidents.state, "RESOLVED")));
      await tx.delete(proxmoxChecks).where(eq(proxmoxChecks.hostId, id));
      await tx.delete(proxmoxHosts).where(eq(proxmoxHosts.id, id));
    });
  }

  async getIncidents(): Promise<Incident[]> {
    return db.select().from(incidents).orderBy(desc(incidents.createdAt));
  }

  async getIncident(id: number): Promise<Incident | undefined> {
    const [result] = await db.select().from(incidents).where(eq(incidents.id, id));
    return result;
  }

  async createIncident(data: InsertIncident): Promise<Incident> {
    const [result] = await db.insert(incidents).values(data).returning();
    return result;
  }

  async updateIncidentState(id: number, state: string): Promise<Incident | undefined> {
    const [result] = await db
      .update(incidents)
      .set({ state, updatedAt: new Date() })
      .where(eq(incidents.id, id))
      .returning();
    return result;
  }

  async getRecipients(): Promise<Recipient[]> {
    return db.select().from(recipients);
  }

  async getRecipient(id: number): Promise<Recipient | undefined> {
    const [result] = await db.select().from(recipients).where(eq(recipients.id, id));
    return result;
  }

  async createRecipient(data: InsertRecipient): Promise<Recipient> {
    const [result] = await db.insert(recipients).values(data).returning();
    return result;
  }

  async updateRecipient(id: number, data: Partial<InsertRecipient>): Promise<Recipient | undefined> {
    if (shouldPruneRecipientRoutesForUpdate(data)) {
      return db.transaction(async (tx) => {
        const [result] = await tx.update(recipients).set(data).where(eq(recipients.id, id)).returning();
        if (result) {
          await pruneRecipientFromNotificationRoutes(tx as unknown as typeof db, id);
        }
        return result;
      });
    }

    const [result] = await db.update(recipients).set(data).where(eq(recipients.id, id)).returning();
    return result;
  }

  async deleteRecipient(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await pruneRecipientFromNotificationRoutes(tx as unknown as typeof db, id);
      await tx.delete(recipients).where(eq(recipients.id, id));
    });
  }

  async getSettings(): Promise<AppSetting[]> {
    const result = await db.select().from(appSettings);
    return result.map((setting) => ({
      ...setting,
      value: isSecretSettingKey(setting.key) ? "" : setting.value,
      hasValue: isSecretSettingKey(setting.key) ? !!setting.value : undefined,
    }));
  }

  async getSettingValue(key: string): Promise<string | undefined> {
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    if (!setting || setting.value == null) {
      return undefined;
    }
    if (isSecretSettingKey(key)) {
      const value = decryptSecret(setting.value);
      return value || undefined;
    }
    const value = setting.value;
    return value ?? undefined;
  }

  async upsertSetting(key: string, value: string): Promise<AppSetting> {
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    const secretValue = isSecretSettingKey(key);
    const clearSecret = secretValue && value === CLEAR_SECRET_SETTING_VALUE;
    const storedValue = clearSecret ? "" : secretValue ? encryptSecret(value) || "" : value;

    if (existing) {
      if (secretValue && value === "") {
        return {
          ...existing,
          value: "",
        };
      }
      const [result] = await db
        .update(appSettings)
        .set({ value: storedValue, updatedAt: new Date() })
        .where(eq(appSettings.key, key))
        .returning();
      return { ...result, value: secretValue ? "" : result.value };
    }
    const [result] = await db.insert(appSettings).values({ key, value: storedValue }).returning();
    return { ...result, value: secretValue ? "" : result.value };
  }

  async getExpectedRuns(limit = 10): Promise<(ExpectedRun & WithJobName)[]> {
    const result = await db
      .select({
        id: expectedRuns.id,
        jobId: expectedRuns.jobId,
        scheduledFor: expectedRuns.scheduledFor,
        deadlineAt: expectedRuns.deadlineAt,
        status: expectedRuns.status,
        linkedEventId: expectedRuns.linkedEventId,
        jobName: jobs.name,
      })
      .from(expectedRuns)
      .leftJoin(jobs, eq(expectedRuns.jobId, jobs.id))
      .orderBy(desc(expectedRuns.scheduledFor))
      .limit(limit);
    return result;
  }

  async getJobRules(jobId?: number): Promise<JobRule[]> {
    if (jobId) {
      return db.select().from(jobRules).where(eq(jobRules.jobId, jobId));
    }
    return db.select().from(jobRules);
  }

  async createJobRule(data: InsertJobRule): Promise<JobRule> {
    const [result] = await db.insert(jobRules).values(data).returning();
    return result;
  }

  async deleteJobRule(id: number): Promise<void> {
    await db.delete(jobRules).where(eq(jobRules.id, id));
  }

  async getEmails(limit = 50): Promise<Email[]> {
    return db.select().from(emails).orderBy(desc(emails.receivedAt)).limit(limit);
  }

  async getUnmatchedEmails(): Promise<Email[]> {
    return db.select().from(emails).where(sql`${emails.matchedJobId} IS NULL`).orderBy(desc(emails.receivedAt));
  }

  async getMatchedEmails(limit = 50): Promise<(Email & WithJobName)[]> {
    const result = await db
      .select({
        id: emails.id,
        folder: emails.folder,
        uidvalidity: emails.uidvalidity,
        uid: emails.uid,
        messageId: emails.messageId,
        fromAddr: emails.fromAddr,
        subject: emails.subject,
        receivedAt: emails.receivedAt,
        snippet: emails.snippet,
        rawExcerpt: emails.rawExcerpt,
        ingestedOk: emails.ingestedOk,
        matchedJobId: emails.matchedJobId,
        jobName: jobs.name,
      })
      .from(emails)
      .innerJoin(jobs, eq(emails.matchedJobId, jobs.id))
      .orderBy(desc(emails.receivedAt))
      .limit(limit);
    return result;
  }

  async getEmail(id: number): Promise<Email | undefined> {
    const [result] = await db.select().from(emails).where(eq(emails.id, id));
    return result;
  }

  async linkEmailToJob(emailId: number, jobId: number): Promise<Email | undefined> {
    return db.transaction(async (tx) => {
      return linkEmailToJobInTransaction(tx as unknown as typeof db, emailId, jobId);
    });
  }

  async getUnmatchedEmailCount(): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(emails)
      .where(sql`${emails.matchedJobId} IS NULL`);
    return result?.count || 0;
  }

  async getEvents(limit = 50): Promise<(Event & WithJobName)[]> {
    const result = await db
      .select({
        id: events.id,
        jobId: events.jobId,
        expectedRunId: events.expectedRunId,
        status: events.status,
        receivedAt: events.receivedAt,
        emailId: events.emailId,
        jobName: jobs.name,
      })
      .from(events)
      .leftJoin(jobs, eq(events.jobId, jobs.id))
      .orderBy(desc(events.receivedAt))
      .limit(limit);
    return result;
  }

  async getProxmoxChecks(hostId: number, limit = 20): Promise<ProxmoxCheck[]> {
    return db
      .select()
      .from(proxmoxChecks)
      .where(eq(proxmoxChecks.hostId, hostId))
      .orderBy(desc(proxmoxChecks.checkedAt))
      .limit(limit);
  }

  async createProxmoxCheck(data: InsertProxmoxCheck): Promise<ProxmoxCheck> {
    const [result] = await db.insert(proxmoxChecks).values(data).returning();
    return result;
  }

  async getBackupTargets(): Promise<(BackupTarget & WithCustomerName)[]> {
    const result = await db
      .select({
        id: backupTargets.id,
        customerId: backupTargets.customerId,
        name: backupTargets.name,
        type: backupTargets.type,
        host: backupTargets.host,
        port: backupTargets.port,
        username: backupTargets.username,
        password: backupTargets.password,
        tlsFingerprint: backupTargets.tlsFingerprint,
        allowInsecureTls: backupTargets.allowInsecureTls,
        enabled: backupTargets.enabled,
        totalBytes: backupTargets.totalBytes,
        usedBytes: backupTargets.usedBytes,
        lastPolledAt: backupTargets.lastPolledAt,
        pollStatus: backupTargets.pollStatus,
        pollError: backupTargets.pollError,
        datastoresJson: backupTargets.datastoresJson,
        customerName: customers.name,
      })
      .from(backupTargets)
      .leftJoin(customers, eq(backupTargets.customerId, customers.id));
    return result.map((target) => this.decryptBackupTarget(target));
  }

  async getBackupTarget(id: number): Promise<BackupTarget | undefined> {
    const [result] = await db.select().from(backupTargets).where(eq(backupTargets.id, id));
    return result ? this.decryptBackupTarget(result) : undefined;
  }

  async getBackupTargetWithCustomer(id: number): Promise<(BackupTarget & WithCustomerName) | undefined> {
    const [result] = await db
      .select({
        id: backupTargets.id,
        customerId: backupTargets.customerId,
        name: backupTargets.name,
        type: backupTargets.type,
        host: backupTargets.host,
        port: backupTargets.port,
        username: backupTargets.username,
        password: backupTargets.password,
        tlsFingerprint: backupTargets.tlsFingerprint,
        allowInsecureTls: backupTargets.allowInsecureTls,
        enabled: backupTargets.enabled,
        totalBytes: backupTargets.totalBytes,
        usedBytes: backupTargets.usedBytes,
        lastPolledAt: backupTargets.lastPolledAt,
        pollStatus: backupTargets.pollStatus,
        pollError: backupTargets.pollError,
        datastoresJson: backupTargets.datastoresJson,
        customerName: customers.name,
      })
      .from(backupTargets)
      .leftJoin(customers, eq(backupTargets.customerId, customers.id))
      .where(eq(backupTargets.id, id));
    return result ? this.decryptBackupTarget(result) : undefined;
  }

  async createBackupTarget(data: InsertBackupTarget): Promise<BackupTarget> {
    const [result] = await db.insert(backupTargets).values({
      ...data,
      password: encryptSecret(data.password) || "",
    }).returning();
    return this.decryptBackupTarget(result);
  }

  async updateBackupTarget(id: number, data: BackupTargetUpdate): Promise<BackupTarget | undefined> {
    const updateData: BackupTargetUpdate = { ...data };
    if (typeof data.password === "string") {
      updateData.password = encryptSecret(data.password) || "";
    }
    const [result] = await db.update(backupTargets).set(updateData).where(eq(backupTargets.id, id)).returning();
    return result ? this.decryptBackupTarget(result) : undefined;
  }

  async deleteBackupTarget(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(incidents)
        .set({ state: "RESOLVED", updatedAt: new Date() })
        .where(and(eq(incidents.sourceType, "MONITOR"), eq(incidents.sourceId, id), ne(incidents.state, "RESOLVED")));
      await tx.delete(backupTargets).where(eq(backupTargets.id, id));
    });
  }

  async getNotificationRoutes(): Promise<NotificationRoute[]> {
    return db.select().from(notificationRoutes);
  }

  async createNotificationRoute(data: InsertNotificationRoute): Promise<NotificationRoute> {
    const [result] = await db.insert(notificationRoutes).values(data).returning();
    return result;
  }

  async deleteNotificationRoute(id: number): Promise<void> {
    await db.delete(notificationRoutes).where(eq(notificationRoutes.id, id));
  }

  async getSchedulerRuns(): Promise<SchedulerRun[]> {
    return db.select().from(schedulerRuns).orderBy(schedulerRuns.workerName);
  }

  async getAuditLogs(limit = 50): Promise<AuditLog[]> {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }

  async createAuditLog(data: InsertAuditLog): Promise<AuditLog> {
    const [result] = await db.insert(auditLogs).values(data).returning();
    return result;
  }

  async purgeOldData(retentionDays: number): Promise<RetentionSummary> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    return db.transaction(async (tx) => {
      const deletedEvents = await tx
        .delete(events)
        .where(sql`
          ${events.receivedAt} < ${cutoff}
          OR ${events.expectedRunId} IN (
            SELECT id FROM ${expectedRuns}
            WHERE ${expectedRuns.deadlineAt} < ${cutoff}
              AND ${expectedRuns.status} <> 'PENDING'
          )
          OR ${events.emailId} IN (
            SELECT id FROM ${emails}
            WHERE ${emails.receivedAt} IS NOT NULL
              AND ${emails.receivedAt} < ${cutoff}
          )
        `)
        .returning({ id: events.id });

      const deletedExpectedRuns = await tx
        .delete(expectedRuns)
        .where(and(lt(expectedRuns.deadlineAt, cutoff), ne(expectedRuns.status, "PENDING")))
        .returning({ id: expectedRuns.id });

      const deletedEmails = await tx
        .delete(emails)
        .where(sql`${emails.receivedAt} IS NOT NULL AND ${emails.receivedAt} < ${cutoff}`)
        .returning({ id: emails.id });

      const deletedProxmoxChecks = await tx
        .delete(proxmoxChecks)
        .where(lt(proxmoxChecks.checkedAt, cutoff))
        .returning({ id: proxmoxChecks.id });

      const deletedIncidents = await tx
        .delete(incidents)
        .where(and(lt(incidents.updatedAt, cutoff), ne(incidents.state, "OPEN")))
        .returning({ id: incidents.id });

      await tx.delete(rateLimitHits).where(lt(rateLimitHits.resetAt, new Date()));

      return {
        cutoff,
        deletedEvents: deletedEvents.length,
        deletedExpectedRuns: deletedExpectedRuns.length,
        deletedEmails: deletedEmails.length,
        deletedProxmoxChecks: deletedProxmoxChecks.length,
        deletedIncidents: deletedIncidents.length,
      };
    });
  }

  async getDashboardStats() {
    const allJobs = await db.select().from(jobs);
    const allHosts = await db.select().from(proxmoxHosts);
    const openInc = await db
      .select()
      .from(incidents)
      .where(eq(incidents.state, "OPEN"));

    const recentRuns = await this.getExpectedRuns(5);
    const recentIncidents = await db
      .select()
      .from(incidents)
      .orderBy(desc(incidents.createdAt))
      .limit(5);

    const hostStatusMap: Record<string, number> = {};
    allHosts.forEach((h) => {
      const s = h.lastStatus || "UNKNOWN";
      hostStatusMap[s] = (hostStatusMap[s] || 0) + 1;
    });

    const systemMap: Record<string, number> = {};
    allJobs.forEach((j) => {
      systemMap[j.systemType] = (systemMap[j.systemType] || 0) + 1;
    });

    return {
      totalJobs: allJobs.length,
      enabledJobs: allJobs.filter((j) => j.enabled).length,
      totalHosts: allHosts.length,
      openIncidents: openInc.length,
      recentRuns,
      recentIncidents,
      hostStatuses: Object.entries(hostStatusMap).map(([status, count]) => ({
        status,
        count,
      })),
      jobsBySystem: Object.entries(systemMap).map(([systemType, count]) => ({
        systemType,
        count,
      })),
    };
  }
}

export const storage = new DatabaseStorage();

export const storageInternals = {
  pruneRecipientFromRoutePayload,
  routePayloadHasRecipients,
  shouldPruneRecipientRoutesForUpdate,
};
