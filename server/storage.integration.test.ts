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
}
