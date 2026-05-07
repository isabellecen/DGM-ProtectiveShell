import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { normalizeTimezone } = await import("./notificationService");

test("normalizeTimezone falls back to UTC for invalid settings", () => {
  assert.equal(normalizeTimezone("America/Phoenix"), "America/Phoenix");
  assert.equal(normalizeTimezone("Not/A_Real_Zone"), "UTC");
});
