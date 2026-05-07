import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { routeInternals } = await import("./routes");

test("job rule validation requires at least one matcher", () => {
  const result = routeInternals.jobRuleCreateSchema.safeParse({
    jobId: 1,
    senderMatch: "",
    subjectMatch: null,
    bodyMatch: "",
  });

  assert.equal(result.success, false);
});

test("setting validation rejects unknown keys and invalid values", () => {
  assert.equal(routeInternals.settingSchema.safeParse({ key: "UNKNOWN", value: "1" }).success, false);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "IMAP_PORT", value: "70000" }).success, false);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "IMAP_TLS", value: "yes" }).success, false);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "APP_TIMEZONE", value: "Mars/Base" }).success, false);
});

test("setting validation accepts supported blank and formatted values", () => {
  assert.equal(routeInternals.settingSchema.safeParse({ key: "IMAP_PORT", value: "" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "APP_TIMEZONE", value: "America/Phoenix" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "DAILY_REPORT_TIME", value: "08:30" }).success, true);
});

test("notification route validation requires ids for scoped routes", () => {
  assert.equal(
    routeInternals.notificationRouteCreateSchema.safeParse({
      scopeType: "CUSTOMER",
      scopeId: null,
      eventType: "FAIL",
      recipientsJson: [],
    }).success,
    false,
  );
});
