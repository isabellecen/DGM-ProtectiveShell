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
