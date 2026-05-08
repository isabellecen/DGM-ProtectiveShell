import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { backupEmailIncidentFingerprint, backupEmailIncidentPreview } = await import("./backupIncidents");

test("backupEmailIncidentFingerprint prefers expected-run fingerprints", () => {
  assert.equal(
    backupEmailIncidentFingerprint({ emailId: 42, expectedRunId: 9 }),
    "backup-status:expected-run:9",
  );
  assert.equal(backupEmailIncidentFingerprint({ emailId: 42 }), "backup-status:email:42");
});

test("backupEmailIncidentPreview opens incidents for failed and warning emails", () => {
  const failed = backupEmailIncidentPreview({
    jobId: 7,
    jobName: "Nightly VM Backup",
    emailId: 42,
    expectedRunId: 9,
    status: "FAIL",
    receivedAt: new Date("2026-05-05T09:30:00.000Z"),
    subject: "TASK ERROR: backup failed",
  });

  assert.equal(failed?.action, "open");
  assert.equal(failed?.severity, "CRIT");
  assert.equal(failed?.sourceFingerprint, "backup-status:expected-run:9");
  assert.equal(failed?.title, "Nightly VM Backup reported failure");

  const warning = backupEmailIncidentPreview({
    jobId: 7,
    emailId: 43,
    status: "WARN",
    receivedAt: new Date("2026-05-05T09:30:00.000Z"),
    subject: "Completed with warnings",
  });
  assert.equal(warning?.action, "open");
  assert.equal(warning?.severity, "WARN");
  assert.equal(warning?.sourceFingerprint, "backup-status:email:43");
});

test("backupEmailIncidentPreview resolves OK emails and ignores unknown emails", () => {
  const ok = backupEmailIncidentPreview({
    jobId: 7,
    emailId: 42,
    expectedRunId: 9,
    status: "OK",
    receivedAt: new Date("2026-05-05T09:30:00.000Z"),
  });
  assert.deepEqual(ok, {
    action: "resolve",
    sourceFingerprint: "backup-status:expected-run:9",
  });

  assert.equal(
    backupEmailIncidentPreview({
      jobId: 7,
      emailId: 42,
      status: "UNKNOWN",
      receivedAt: new Date("2026-05-05T09:30:00.000Z"),
    }),
    null,
  );
});
