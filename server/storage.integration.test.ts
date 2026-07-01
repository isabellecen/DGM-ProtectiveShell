import assert from "node:assert/strict";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  appSettings,
  customers,
  emails,
  events,
  expectedRuns,
  incidents,
  jobs,
} from "@shared/schema";
import { CLEAR_SECRET_SETTING_VALUE } from "@shared/settings";

const runIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "1";

if (!runIntegrationTests) {
  test("storage integration tests", { skip: "set RUN_DB_INTEGRATION_TESTS=1 to run database-backed tests" }, () => {});
} else {
  test("linkEmailToJob resets the previous run and resolves its incident", async () => {
    const { db } = await import("./db");
    const { storage } = await import("./storage");
    const { backupEmailIncidentFingerprint } = await import("./backupIncidents");

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const receivedAt = new Date("2026-05-08T09:00:00.000Z");
    const scheduledFor = new Date("2026-05-08T08:00:00.000Z");
    const deadlineAt = new Date("2026-05-08T12:00:00.000Z");

    const createdJobIds: number[] = [];
    const createdRunIds: number[] = [];
    const createdEmailIds: number[] = [];
    const createdEventIds: number[] = [];
    const createdIncidentFingerprints: string[] = [];
    let createdCustomerId: number | undefined;

    try {
      const [customer] = await db.insert(customers).values({ name: `codex-test-${suffix}` }).returning();
      createdCustomerId = customer.id;

      const [oldJob] = await db
        .insert(jobs)
        .values({
          customerId: customer.id,
          name: `old-job-${suffix}`,
          systemType: "PBS",
          scheduleType: "daily",
          scheduleTime: "02:00",
          windowHours: 6,
        })
        .returning();
      const [newJob] = await db
        .insert(jobs)
        .values({
          customerId: customer.id,
          name: `new-job-${suffix}`,
          systemType: "PBS",
          scheduleType: "daily",
          scheduleTime: "02:00",
          windowHours: 6,
        })
        .returning();
      createdJobIds.push(oldJob.id, newJob.id);

      const [oldRun] = await db
        .insert(expectedRuns)
        .values({
          jobId: oldJob.id,
          scheduledFor,
          deadlineAt,
          status: "FAIL",
        })
        .returning();
      const [newRun] = await db
        .insert(expectedRuns)
        .values({
          jobId: newJob.id,
          scheduledFor,
          deadlineAt,
          status: "PENDING",
        })
        .returning();
      createdRunIds.push(oldRun.id, newRun.id);

      const [email] = await db
        .insert(emails)
        .values({
          folder: `codex-${suffix}`,
          uidvalidity: 1,
          uid: 1,
          messageId: `<codex-${suffix}@example.test>`,
          fromAddr: "backup@example.test",
          subject: "Backup failed",
          receivedAt,
          snippet: "Task error during backup",
          rawExcerpt: "Task error during backup",
          ingestedOk: true,
          matchedJobId: oldJob.id,
        })
        .returning();
      createdEmailIds.push(email.id);

      const [event] = await db
        .insert(events)
        .values({
          jobId: oldJob.id,
          expectedRunId: oldRun.id,
          status: "FAIL",
          receivedAt,
          emailId: email.id,
        })
        .returning();
      createdEventIds.push(event.id);

      await db.update(expectedRuns).set({ linkedEventId: event.id }).where(eq(expectedRuns.id, oldRun.id));

      const oldFingerprint = backupEmailIncidentFingerprint({ emailId: email.id, expectedRunId: oldRun.id });
      const newFingerprint = backupEmailIncidentFingerprint({ emailId: email.id, expectedRunId: newRun.id });
      createdIncidentFingerprints.push(oldFingerprint, newFingerprint);
      await db.insert(incidents).values({
        sourceType: "BACKUP",
        sourceId: oldJob.id,
        severity: "CRIT",
        title: "Old job reported failure",
        details: "Created by storage integration test.",
        state: "OPEN",
        sourceFingerprint: oldFingerprint,
      });

      const linkedEmail = await storage.linkEmailToJob(email.id, newJob.id);
      assert.equal(linkedEmail?.matchedJobId, newJob.id);

      const [oldRunAfter] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, oldRun.id));
      assert.equal(oldRunAfter.status, "PENDING");
      assert.equal(oldRunAfter.linkedEventId, null);

      const [newRunAfter] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, newRun.id));
      assert.equal(newRunAfter.status, "FAIL");
      assert.equal(newRunAfter.linkedEventId, event.id);

      const [eventAfter] = await db.select().from(events).where(eq(events.id, event.id));
      assert.equal(eventAfter.jobId, newJob.id);
      assert.equal(eventAfter.expectedRunId, newRun.id);

      const [oldIncidentAfter] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, oldFingerprint));
      assert.equal(oldIncidentAfter.state, "RESOLVED");
    } finally {
      if (createdIncidentFingerprints.length) {
        await db.delete(incidents).where(inArray(incidents.sourceFingerprint, createdIncidentFingerprints));
      }
      if (createdEventIds.length) {
        await db.delete(events).where(inArray(events.id, createdEventIds));
      }
      if (createdRunIds.length) {
        await db.delete(expectedRuns).where(inArray(expectedRuns.id, createdRunIds));
      }
      if (createdEmailIds.length) {
        await db.delete(emails).where(inArray(emails.id, createdEmailIds));
      }
      if (createdJobIds.length) {
        await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (createdCustomerId) {
        await db.delete(customers).where(eq(customers.id, createdCustomerId));
      }
    }
  });

  test("secret settings distinguish preserve-empty from explicit clear", async () => {
    const { db } = await import("./db");
    const { storage } = await import("./storage");
    const key = `CODEX_TEST_${Date.now()}_${Math.random().toString(16).slice(2)}_SECRET`;

    try {
      await storage.upsertSetting(key, "stored-value");
      assert.equal(await storage.getSettingValue(key), "stored-value");

      const afterBlankSave = await storage.upsertSetting(key, "");
      assert.equal(afterBlankSave.value, "");
      assert.equal(await storage.getSettingValue(key), "stored-value");

      const withSecret = (await storage.getSettings()).find((setting) => setting.key === key) as
        | ({ hasValue?: boolean } & Awaited<ReturnType<typeof storage.getSettings>>[number])
        | undefined;
      assert.equal(withSecret?.value, "");
      assert.equal(withSecret?.hasValue, true);

      await storage.upsertSetting(key, CLEAR_SECRET_SETTING_VALUE);
      assert.equal(await storage.getSettingValue(key), undefined);

      const afterClear = (await storage.getSettings()).find((setting) => setting.key === key) as
        | ({ hasValue?: boolean } & Awaited<ReturnType<typeof storage.getSettings>>[number])
        | undefined;
      assert.equal(afterClear?.value, "");
      assert.equal(afterClear?.hasValue, false);

      await db.delete(appSettings).where(eq(appSettings.key, key));
      const afterMissingBlankSave = await storage.upsertSetting(key, "");
      assert.equal(afterMissingBlankSave.value, "");
      assert.equal(await storage.getSettingValue(key), undefined);
      const missingBlankSecret = (await storage.getSettings()).find((setting) => setting.key === key) as
        | ({ hasValue?: boolean } & Awaited<ReturnType<typeof storage.getSettings>>[number])
        | undefined;
      assert.equal(missingBlankSecret?.hasValue, false);
    } finally {
      await db.delete(appSettings).where(eq(appSettings.key, key));
    }
  });

  test("Proxmox webhook ingestion links runs and syncs backup incidents", async () => {
    const { db } = await import("./db");
    const { storage } = await import("./storage");
    const { backupWebhookIncidentFingerprint } = await import("./backupIncidents");
    const { proxmoxWebhookFingerprint } = await import("./proxmoxWebhook");

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const receivedAt = new Date("2026-06-30T10:30:00.000Z");
    const okReceivedAt = new Date("2026-06-30T11:00:00.000Z");
    const outsideWindowOkReceivedAt = new Date("2026-06-30T18:00:00.000Z");
    const scheduledFor = new Date("2026-06-30T10:00:00.000Z");
    const deadlineAt = new Date("2026-06-30T14:00:00.000Z");
    const oldScheduledFor = new Date("2026-06-30T01:00:00.000Z");
    const oldDeadlineAt = new Date("2026-06-30T02:00:00.000Z");

    const createdJobIds: number[] = [];
    const createdRunIds: number[] = [];
    const createdEventIds: number[] = [];
    const createdIncidentFingerprints: string[] = [];
    let createdCustomerId: number | undefined;

    try {
      const [customer] = await db.insert(customers).values({ name: `webhook-test-${suffix}` }).returning();
      createdCustomerId = customer.id;

      const [job] = await db
        .insert(jobs)
        .values({
          customerId: customer.id,
          name: `webhook-job-${suffix}`,
          systemType: "PBS",
          scheduleType: "daily",
          scheduleTime: "10:00",
          windowHours: 4,
          webhookSource: "PVE",
          webhookJobId: `backup-${suffix}`,
          webhookHost: "pve1",
        })
        .returning();
      createdJobIds.push(job.id);

      const [run] = await db
        .insert(expectedRuns)
        .values({
          jobId: job.id,
          scheduledFor,
          deadlineAt,
          status: "PENDING",
        })
        .returning();
      createdRunIds.push(run.id);

      const [oldRun] = await db
        .insert(expectedRuns)
        .values({
          jobId: job.id,
          scheduledFor: oldScheduledFor,
          deadlineAt: oldDeadlineAt,
          status: "FAIL",
        })
        .returning();
      createdRunIds.push(oldRun.id);

      const webhookIdentity = {
        source: "PVE",
        eventType: "vzdump",
        webhookJobId: `backup-${suffix}`,
        host: "pve1",
      };

      const sourceFingerprint = proxmoxWebhookFingerprint({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        timestamp: receivedAt,
        severity: "error",
      });
      createdIncidentFingerprints.push(backupWebhookIncidentFingerprint({
        ...webhookIdentity,
        expectedRunId: run.id,
      }));
      const oldRunIncidentFingerprint = backupWebhookIncidentFingerprint({
        ...webhookIdentity,
        expectedRunId: oldRun.id,
      });
      createdIncidentFingerprints.push(oldRunIncidentFingerprint);
      await db.insert(incidents).values({
        sourceType: "BACKUP",
        sourceId: job.id,
        severity: "CRIT",
        title: "Old run reported failure",
        details: "Created by storage integration test.",
        state: "OPEN",
        sourceFingerprint: oldRunIncidentFingerprint,
      });

      const result = await storage.ingestProxmoxWebhookEvent({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        severity: "error",
        status: "FAIL",
        receivedAt,
        title: "Backup failed",
        message: "TASK ERROR",
        fingerprint: sourceFingerprint,
        payload: { test: true },
      });

      assert.equal(result.status, "processed");
      if (result.status === "processed") {
        createdEventIds.push(result.eventId);
        assert.equal(result.jobId, job.id);
        assert.equal(result.expectedRunId, run.id);
      }

      const [runAfter] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, run.id));
      assert.equal(runAfter.status, "FAIL");

      const [eventAfter] = await db.select().from(events).where(eq(events.sourceFingerprint, sourceFingerprint));
      assert.equal(eventAfter.sourceType, "BACKUP_WEBHOOK");
      assert.equal(eventAfter.expectedRunId, run.id);

      const [incidentAfter] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, createdIncidentFingerprints[0]));
      assert.equal(incidentAfter.state, "OPEN");
      assert.equal(incidentAfter.severity, "CRIT");

      const okFingerprint = proxmoxWebhookFingerprint({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        timestamp: okReceivedAt,
        severity: "info",
      });
      const okResult = await storage.ingestProxmoxWebhookEvent({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        severity: "info",
        status: "OK",
        receivedAt: okReceivedAt,
        title: "Backup succeeded",
        message: "OK",
        fingerprint: okFingerprint,
        payload: { test: true },
      });

      assert.equal(okResult.status, "processed");
      if (okResult.status === "processed") {
        createdEventIds.push(okResult.eventId);
        assert.equal(okResult.expectedRunId, run.id);
      }

      const [runAfterOk] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, run.id));
      assert.equal(runAfterOk.status, "OK");

      const [incidentAfterOk] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, createdIncidentFingerprints[0]));
      assert.equal(incidentAfterOk.state, "RESOLVED");

      const duplicateFailResult = await storage.ingestProxmoxWebhookEvent({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        severity: "error",
        status: "FAIL",
        receivedAt,
        title: "Backup failed",
        message: "TASK ERROR",
        fingerprint: sourceFingerprint,
        payload: { test: true, duplicate: true },
      });

      assert.equal(duplicateFailResult.status, "processed");
      if (duplicateFailResult.status === "processed") {
        assert.equal(duplicateFailResult.duplicate, true);
        assert.equal(duplicateFailResult.eventId, result.eventId);
        assert.equal(duplicateFailResult.expectedRunId, run.id);
        assert.equal(duplicateFailResult.eventStatus, "FAIL");
      }

      const [runAfterDuplicateFail] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, run.id));
      assert.equal(runAfterDuplicateFail.status, "OK");

      const [incidentAfterDuplicateFail] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, createdIncidentFingerprints[0]));
      assert.equal(incidentAfterDuplicateFail.state, "RESOLVED");

      const [eventAfterDuplicateFail] = await db.select().from(events).where(eq(events.sourceFingerprint, sourceFingerprint));
      assert.equal(eventAfterDuplicateFail.status, "FAIL");
      assert.equal(eventAfterDuplicateFail.receivedAt.toISOString(), receivedAt.toISOString());
      assert.deepEqual(eventAfterDuplicateFail.payloadJson, { test: true });

      const outsideWindowOkFingerprint = proxmoxWebhookFingerprint({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        timestamp: outsideWindowOkReceivedAt,
        severity: "info",
      });
      const outsideWindowOkResult = await storage.ingestProxmoxWebhookEvent({
        source: "PVE",
        eventType: "vzdump",
        jobId: `backup-${suffix}`,
        host: "pve1",
        severity: "info",
        status: "OK",
        receivedAt: outsideWindowOkReceivedAt,
        title: "Backup succeeded",
        message: "OK",
        fingerprint: outsideWindowOkFingerprint,
        payload: { test: true },
      });

      assert.equal(outsideWindowOkResult.status, "processed");
      if (outsideWindowOkResult.status === "processed") {
        createdEventIds.push(outsideWindowOkResult.eventId);
        assert.equal(outsideWindowOkResult.expectedRunId, null);
      }

      const [oldRunIncidentAfterOk] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, oldRunIncidentFingerprint));
      assert.equal(oldRunIncidentAfterOk.state, "OPEN");
    } finally {
      if (createdIncidentFingerprints.length) {
        await db.delete(incidents).where(inArray(incidents.sourceFingerprint, createdIncidentFingerprints));
      }
      if (createdEventIds.length) {
        await db.delete(events).where(inArray(events.id, createdEventIds));
      }
      if (createdRunIds.length) {
        await db.delete(expectedRuns).where(inArray(expectedRuns.id, createdRunIds));
      }
      if (createdJobIds.length) {
        await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (createdCustomerId) {
        await db.delete(customers).where(eq(customers.id, createdCustomerId));
      }
    }
  });

  test("DSM webhook ingestion links runs and syncs backup incidents", async () => {
    const { db } = await import("./db");
    const { storage } = await import("./storage");
    const { backupWebhookIncidentFingerprint } = await import("./backupIncidents");
    const { backupWebhookFingerprint } = await import("./backupWebhook");

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const taskName = `CloudStation Backup ${suffix}`;
    const receivedAt = new Date("2026-06-30T10:30:00.000Z");
    const okReceivedAt = new Date("2026-06-30T11:00:00.000Z");
    const scheduledFor = new Date("2026-06-30T10:00:00.000Z");
    const deadlineAt = new Date("2026-06-30T14:00:00.000Z");

    const createdJobIds: number[] = [];
    const createdRunIds: number[] = [];
    const createdEventIds: number[] = [];
    const createdIncidentFingerprints: string[] = [];
    let createdCustomerId: number | undefined;

    try {
      const [customer] = await db.insert(customers).values({ name: `dsm-webhook-test-${suffix}` }).returning();
      createdCustomerId = customer.id;

      const [job] = await db
        .insert(jobs)
        .values({
          customerId: customer.id,
          name: `dsm-webhook-job-${suffix}`,
          systemType: "SYNOLOGY",
          scheduleType: "daily",
          scheduleTime: "10:00",
          windowHours: 4,
          webhookSource: "DSM",
          webhookJobId: taskName,
          webhookHost: "nas1",
        })
        .returning();
      createdJobIds.push(job.id);

      const [run] = await db
        .insert(expectedRuns)
        .values({
          jobId: job.id,
          scheduledFor,
          deadlineAt,
          status: "PENDING",
        })
        .returning();
      createdRunIds.push(run.id);

      const incidentFingerprint = backupWebhookIncidentFingerprint({
        source: "DSM",
        eventType: "hyper-backup",
        webhookJobId: taskName,
        host: "nas1",
        expectedRunId: run.id,
      });
      createdIncidentFingerprints.push(incidentFingerprint);

      const failFingerprint = backupWebhookFingerprint({
        source: "DSM",
        eventType: "hyper-backup",
        jobId: taskName,
        host: "nas1",
        timestamp: receivedAt,
        severity: "FAIL",
      });
      const failed = await storage.ingestBackupWebhookEvent({
        source: "DSM",
        eventType: "hyper-backup",
        jobId: taskName,
        host: "nas1",
        severity: "error",
        status: "FAIL",
        receivedAt,
        title: "Hyper Backup task failed",
        message: "Task failed",
        fingerprint: failFingerprint,
        payload: { test: true },
      });

      assert.equal(failed.status, "processed");
      if (failed.status === "processed") {
        createdEventIds.push(failed.eventId);
        assert.equal(failed.jobId, job.id);
        assert.equal(failed.expectedRunId, run.id);
      }

      const [eventAfterFail] = await db.select().from(events).where(eq(events.sourceFingerprint, failFingerprint));
      assert.equal(eventAfterFail.sourceType, "BACKUP_WEBHOOK");
      assert.equal(eventAfterFail.status, "FAIL");

      const [incidentAfterFail] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, incidentFingerprint));
      assert.equal(incidentAfterFail.state, "OPEN");

      const duplicateFail = await storage.ingestBackupWebhookEvent({
        source: "DSM",
        eventType: "hyper-backup",
        jobId: taskName,
        host: "nas1",
        severity: "error",
        status: "FAIL",
        receivedAt,
        title: "Hyper Backup task failed",
        message: "Task failed",
        fingerprint: failFingerprint,
        payload: { test: true, duplicate: true },
      });
      assert.equal(duplicateFail.status, "processed");
      if (duplicateFail.status === "processed") {
        assert.equal(duplicateFail.duplicate, true);
        assert.equal(duplicateFail.eventId, failed.status === "processed" ? failed.eventId : 0);
      }

      const okFingerprint = backupWebhookFingerprint({
        source: "DSM",
        eventType: "hyper-backup",
        jobId: taskName,
        host: "nas1",
        timestamp: okReceivedAt,
        severity: "OK",
      });
      const ok = await storage.ingestBackupWebhookEvent({
        source: "DSM",
        eventType: "hyper-backup",
        jobId: taskName,
        host: "nas1",
        severity: "info",
        status: "OK",
        receivedAt: okReceivedAt,
        title: "Hyper Backup task completed",
        message: "Task completed successfully",
        fingerprint: okFingerprint,
        payload: { test: true },
      });

      assert.equal(ok.status, "processed");
      if (ok.status === "processed") {
        createdEventIds.push(ok.eventId);
        assert.equal(ok.expectedRunId, run.id);
      }

      const [runAfterOk] = await db.select().from(expectedRuns).where(eq(expectedRuns.id, run.id));
      assert.equal(runAfterOk.status, "OK");

      const [incidentAfterOk] = await db
        .select()
        .from(incidents)
        .where(eq(incidents.sourceFingerprint, incidentFingerprint));
      assert.equal(incidentAfterOk.state, "RESOLVED");
    } finally {
      if (createdIncidentFingerprints.length) {
        await db.delete(incidents).where(inArray(incidents.sourceFingerprint, createdIncidentFingerprints));
      }
      if (createdEventIds.length) {
        await db.delete(events).where(inArray(events.id, createdEventIds));
      }
      if (createdRunIds.length) {
        await db.delete(expectedRuns).where(inArray(expectedRuns.id, createdRunIds));
      }
      if (createdJobIds.length) {
        await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (createdCustomerId) {
        await db.delete(customers).where(eq(customers.id, createdCustomerId));
      }
    }
  });
}
