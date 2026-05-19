import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { normalizeTimezone, notificationServiceInternals } = await import("./notificationService");

test("normalizeTimezone falls back to UTC for invalid settings", () => {
  assert.equal(normalizeTimezone("America/Phoenix"), "America/Phoenix");
  assert.equal(normalizeTimezone("Not/A_Real_Zone"), "UTC");
});

test("matching notification routes with no valid recipients do not request fallback recipients", () => {
  const allRecipients = [
    {
      id: 1,
      name: "Ops",
      email: "ops@example.com",
      type: "TECH",
      customerId: null,
      enabled: true,
    },
  ];

  assert.deepEqual(
    notificationServiceInternals.recipientsForMatchingRoutes(
      [{ recipientsJson: [999] }],
      allRecipients as any,
    ),
    [],
  );
  assert.equal(
    notificationServiceInternals.recipientsForMatchingRoutes(
      [{ recipientsJson: null }],
      allRecipients as any,
    ),
    null,
  );
  assert.equal(notificationServiceInternals.recipientsForMatchingRoutes([], allRecipients as any), null);
});

test("SMTP address and message formatting rejects injection edge cases", () => {
  assert.equal(notificationServiceInternals.normalizeSmtpAddress("ops@example.com"), "ops@example.com");
  assert.equal(notificationServiceInternals.normalizeSmtpAddress("ops@example.com\r\nBCC: bad@example.com"), null);

  const message = notificationServiceInternals.formatMessage(
    "ops@example.com",
    ["tech@example.com"],
    "Hello\r\nBCC: bad@example.com",
    ".first line\n.second line",
  );

  assert.match(message, /Subject: Hello BCC: bad@example\.com/);
  assert.match(message, /\r\n\.\.first line\r\n\.\.second line\r\n\.\r\n$/);
});
