import assert from "node:assert/strict";
import test from "node:test";
import { parseBackupWebhookPayload } from "./backupWebhook";

test("DSM webhook parser accepts structured Hyper Backup payloads", () => {
  const result = parseBackupWebhookPayload({
    source: "SYNOLOGY",
    eventType: "hyper-backup",
    taskName: "CloudStation Backup",
    host: "techcorp-nas",
    status: "failed",
    timestamp: "2026-06-30T12:00:00.000Z",
    title: "Hyper Backup task failed",
    message: "Task 'CloudStation Backup' failed because the remote server timed out.",
  });

  assert.equal(result.kind, "event");
  if (result.kind === "event") {
    assert.equal(result.event.source, "DSM");
    assert.equal(result.event.eventType, "hyper-backup");
    assert.equal(result.event.jobId, "CloudStation Backup");
    assert.equal(result.event.host, "techcorp-nas");
    assert.equal(result.event.status, "FAIL");
    assert.equal(result.event.receivedAt.toISOString(), "2026-06-30T12:00:00.000Z");
    assert.match(result.event.fingerprint, /^backup-webhook:dsm:hyper-backup:cloudstation_backup:techcorp-nas:/);
  }
});

test("DSM webhook parser falls back to Hyper Backup notification text", () => {
  const now = new Date("2026-06-30T12:04:30.000Z");
  const result = parseBackupWebhookPayload({
    source: "DSM",
    message: "Hyper Backup - [TechCorp-NAS] Task 'CloudStation Backup' completed successfully.",
  }, now);

  assert.equal(result.kind, "event");
  if (result.kind === "event") {
    assert.equal(result.event.source, "DSM");
    assert.equal(result.event.jobId, "CloudStation Backup");
    assert.equal(result.event.host, "TechCorp-NAS");
    assert.equal(result.event.status, "OK");
    assert.equal(result.event.receivedAt.toISOString(), now.toISOString());
    assert.match(result.event.fingerprint, /2026-06-30T12:00:00.000Z:ok:/);
  }
});

test("DSM webhook parser maps warning and failed text notifications", () => {
  const warned = parseBackupWebhookPayload({
    source: "DSM",
    message: "Hyper Backup task Legal Archive on nas1 warning: some files were skipped.",
  }, new Date("2026-06-30T12:00:00.000Z"));
  assert.equal(warned.kind, "event");
  if (warned.kind === "event") {
    assert.equal(warned.event.jobId, "Legal Archive");
    assert.equal(warned.event.status, "WARN");
  }

  const failed = parseBackupWebhookPayload({
    source: "DSM",
    message: "Task: Legal Archive\nStatus: Failed\nHyper Backup encountered an error.",
  }, new Date("2026-06-30T12:00:00.000Z"));
  assert.equal(failed.kind, "event");
  if (failed.kind === "event") {
    assert.equal(failed.event.jobId, "Legal Archive");
    assert.equal(failed.event.status, "FAIL");
  }
});

test("DSM webhook parser ignores non-backup and unmappable notifications", () => {
  assert.deepEqual(
    parseBackupWebhookPayload({
      source: "DSM",
      eventType: "storage",
      message: "Volume usage is high.",
    }),
    { kind: "ignored", reason: "non-backup DSM notification" },
  );

  assert.deepEqual(
    parseBackupWebhookPayload({
      source: "DSM",
      eventType: "hyper-backup",
      message: "Hyper Backup reported a status change.",
    }),
    { kind: "ignored", reason: "missing DSM task name" },
  );
});
