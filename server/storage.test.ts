import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { storageInternals } = await import("./storage");

test("recipient route payload cleanup removes deleted recipient ids", () => {
  assert.deepEqual(storageInternals.pruneRecipientFromRoutePayload([1, 2, "3"], 2), [1, "3"]);
  assert.deepEqual(
    storageInternals.pruneRecipientFromRoutePayload(
      [{ recipientIds: [1, 2], emails: ["ops@example.com"] }],
      2,
    ),
    [{ recipientIds: [1], emails: ["ops@example.com"] }],
  );
});

test("recipient route payload cleanup identifies empty routes", () => {
  const emptyPayload = storageInternals.pruneRecipientFromRoutePayload([2], 2);

  assert.equal(Array.isArray(emptyPayload), true);
  assert.equal(storageInternals.routePayloadHasRecipients(emptyPayload), false);
  assert.equal(storageInternals.routePayloadHasRecipients({ recipientIds: [], emails: [] }), false);
  assert.equal(storageInternals.routePayloadHasRecipients(["ops@example.com"]), true);
});

test("recipient route payload cleanup runs when recipients are disabled", () => {
  assert.equal(storageInternals.shouldPruneRecipientRoutesForUpdate({ enabled: false }), true);
  assert.equal(storageInternals.shouldPruneRecipientRoutesForUpdate({ enabled: true }), false);
  assert.equal(storageInternals.shouldPruneRecipientRoutesForUpdate({ name: "Ops" }), false);
});

test("webhook job matching prefers exact host matches", () => {
  const result = storageInternals.selectWebhookJobMatch(
    [
      { id: 1, webhookHost: null },
      { id: 2, webhookHost: "pve1" },
    ],
    "PVE1",
  );

  assert.equal(result.status, "matched");
  if (result.status === "matched") {
    assert.equal(result.job.id, 2);
  }
});

test("webhook job matching accepts exactly one unscoped job", () => {
  const single = storageInternals.selectWebhookJobMatch([{ id: 1, webhookHost: null }], "pve1");
  assert.equal(single.status, "matched");
  if (single.status === "matched") {
    assert.equal(single.job.id, 1);
  }
});

test("webhook job matching rejects scoped mappings without a matching host", () => {
  assert.equal(
    storageInternals.selectWebhookJobMatch([{ id: 1, webhookHost: "pve1" }], null).status,
    "ignored",
  );

  assert.equal(
    storageInternals.selectWebhookJobMatch([{ id: 1, webhookHost: "pve1" }], "pve2").status,
    "ignored",
  );
});

test("webhook job matching rejects ambiguous source and job-id mappings", () => {
  const ambiguous = storageInternals.selectWebhookJobMatch(
    [
      { id: 1, webhookHost: null },
      { id: 2, webhookHost: "" },
    ],
    null,
  );

  assert.deepEqual(ambiguous, {
    status: "ignored",
    reason: "multiple jobs matched source and job-id without a host",
  });

  assert.equal(
    storageInternals.selectWebhookJobMatch(
      [
        { id: 1, webhookHost: null },
        { id: 2, webhookHost: "pve1" },
      ],
      "pve2",
    ).status,
    "ignored",
  );
});

test("webhook run window matches daily schedule around incoming event", () => {
  const window = storageInternals.webhookRunWindowForEvent(
    {
      scheduleType: "daily",
      scheduleTime: "11:00",
      daysOfWeek: [],
      windowHours: 6,
      longRunning: false,
      longWindowHours: 24,
    },
    new Date("2026-07-01T18:41:30.000Z"),
    "America/Phoenix",
  );

  assert(window);
  assert.equal(window.scheduledFor.toISOString(), "2026-07-01T18:00:00.000Z");
  assert.equal(window.deadlineAt.toISOString(), "2026-07-02T00:00:00.000Z");
});

test("webhook run window supports long jobs crossing local days", () => {
  const window = storageInternals.webhookRunWindowForEvent(
    {
      scheduleType: "daily",
      scheduleTime: "23:00",
      daysOfWeek: [],
      windowHours: 6,
      longRunning: false,
      longWindowHours: 24,
    },
    new Date("2026-07-02T07:30:00.000Z"),
    "America/Phoenix",
  );

  assert(window);
  assert.equal(window.scheduledFor.toISOString(), "2026-07-02T06:00:00.000Z");
  assert.equal(window.deadlineAt.toISOString(), "2026-07-02T12:00:00.000Z");
});
