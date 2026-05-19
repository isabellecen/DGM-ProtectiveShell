import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const {
  detectEventStatus,
  emailPollerInternals,
  parseEmailSource,
  selectUidsForPoll,
} = await import("./emailPoller");

test("detectEventStatus classifies common backup messages", () => {
  assert.equal(detectEventStatus("Backup completed successfully"), "OK");
  assert.equal(detectEventStatus("Completed with 2 warnings"), "WARN");
  assert.equal(detectEventStatus("TASK ERROR: sync job failed"), "FAIL");
  assert.equal(detectEventStatus("Backup completed successfully with 0 errors and 0 warnings"), "OK");
  assert.equal(detectEventStatus("Backup finished. No errors. No warnings."), "OK");
  assert.equal(detectEventStatus("Started backup job"), "UNKNOWN");
});

test("selectUidsForPoll fetches the oldest unprocessed batch first", () => {
  assert.deepEqual(selectUidsForPoll([7, 3, 6, 4, 5], 2, 2), [3, 4]);
});

test("mailbox storage keys separate accounts that share folder and UID values", () => {
  const base = {
    host: "mail.example.com",
    port: 993,
    username: "backup-a",
    folder: "INBOX",
    useTls: true,
  };

  const first = emailPollerInternals.mailboxStorageKey(base);
  const second = emailPollerInternals.mailboxStorageKey({ ...base, username: "backup-b" });

  assert.notEqual(first, second);
  assert.match(first, /^INBOX#[a-f0-9]{16}$/);
  assert.equal(first.includes("backup-a"), false);
});

test("checkpoint selection falls back to legacy folder checkpoint once", () => {
  assert.equal(
    emailPollerInternals.checkpointLastSeenUid(undefined, { uidvalidity: 7, lastSeenUid: 120 }, 7),
    120,
  );
  assert.equal(
    emailPollerInternals.checkpointLastSeenUid({ uidvalidity: 7, lastSeenUid: 130 }, { uidvalidity: 7, lastSeenUid: 120 }, 7),
    130,
  );
  assert.equal(
    emailPollerInternals.checkpointLastSeenUid(undefined, { uidvalidity: 6, lastSeenUid: 120 }, 7),
    0,
  );
});

test("parseEmailSource extracts headers and snippet from IMAP fetch output", async () => {
  const parsed = await parseEmailSource(`* 1 FETCH (UID 12 BODY[]<0> {220}
Message-ID: <abc@example.com>
From: Backup <backup@example.com>
Subject: =?UTF-8?Q?Backup_completed_successfully?=
Date: Tue, 05 May 2026 02:30:00 -0700

Backup job finished successfully.
)
A0001 OK FETCH completed`);

  assert.equal(parsed.messageId, "<abc@example.com>");
  assert.equal(parsed.fromAddr, "Backup <backup@example.com>");
  assert.equal(parsed.subject, "Backup completed successfully");
  assert.equal(parsed.receivedAt?.toISOString(), "2026-05-05T09:30:00.000Z");
  assert.equal(parsed.snippet, "Backup job finished successfully.");
});

test("parseEmailSource reads multipart text alternatives", async () => {
  const parsed = await parseEmailSource(`From: Backup <backup@example.com>
Subject: Multipart report
Date: Tue, 05 May 2026 02:30:00 -0700
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="report-boundary"

--report-boundary
Content-Type: text/plain; charset=utf-8

Backup completed successfully.

--report-boundary
Content-Type: text/html; charset=utf-8

<p>Backup completed successfully.</p>
--report-boundary--`);

  assert.equal(parsed.subject, "Multipart report");
  assert.equal(parsed.snippet, "Backup completed successfully.");
});
