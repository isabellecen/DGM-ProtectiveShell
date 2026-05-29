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
  assert.equal(routeInternals.settingSchema.safeParse({ key: "SMTP_FROM", value: "ops\r\nBcc: bad@example.com" }).success, false);
});

test("setting validation accepts supported blank and formatted values", () => {
  assert.equal(routeInternals.settingSchema.safeParse({ key: "IMAP_PORT", value: "" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "APP_TIMEZONE", value: "America/Phoenix" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "DAILY_REPORT_TIME", value: "08:30" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "SMTP_FROM", value: "ops@example.com" }).success, true);
});

test("notification route validation requires ids for scoped routes", () => {
  assert.equal(
    routeInternals.notificationRouteCreateSchema.safeParse({
      scopeType: "CUSTOMER",
      scopeId: null,
      eventType: "FAIL",
      recipientsJson: [1],
    }).success,
    false,
  );
});

test("notification route validation rejects empty recipient routes", () => {
  assert.equal(
    routeInternals.notificationRouteCreateSchema.safeParse({
      scopeType: "GLOBAL",
      eventType: "FAIL",
      recipientsJson: [],
    }).success,
    false,
  );
});

test("job patch validation rejects weekly jobs without selected days", () => {
  assert.throws(
    () => routeInternals.assertJobPatchScheduleValid(
      { scheduleType: "daily", daysOfWeek: [] },
      { scheduleType: "weekly" },
    ),
    /Select at least one weekday/,
  );

  assert.throws(
    () => routeInternals.assertJobPatchScheduleValid(
      { scheduleType: "weekly", daysOfWeek: ["monday"] },
      { daysOfWeek: [] },
    ),
    /Select at least one weekday/,
  );

  assert.doesNotThrow(() => routeInternals.assertJobPatchScheduleValid(
    { scheduleType: "daily", daysOfWeek: [] },
    { scheduleType: "weekly", daysOfWeek: ["monday"] },
  ));
});

test("email job creation validation uses full job create rules", () => {
  assert.equal(
    routeInternals.emailCreateJobSchema.safeParse({
      job: {
        name: "Weekly",
        systemType: "PBS",
        scheduleType: "weekly",
        scheduleTime: "02:00",
        daysOfWeek: [],
      },
      createRule: true,
    }).success,
    false,
  );

  assert.equal(
    routeInternals.emailCreateJobSchema.safeParse({
      job: {
        name: "Daily",
        systemType: "VEEAM",
        scheduleType: "daily",
        scheduleTime: "02:00",
      },
      createRule: true,
    }).success,
    true,
  );
});

test("backup target default ports match supported server types", () => {
  assert.equal(routeInternals.defaultBackupTargetPort("PBS"), 8007);
  assert.equal(routeInternals.defaultBackupTargetPort("SYNOLOGY"), 5001);
});

test("pagination query validation applies defaults and bounds", () => {
  assert.deepEqual(routeInternals.paginationQuerySchema.parse({}), { limit: 100, offset: 0 });
  assert.deepEqual(routeInternals.paginationQuerySchema.parse({ limit: "25", offset: "50" }), {
    limit: 25,
    offset: 50,
  });
  assert.equal(routeInternals.paginationQuerySchema.safeParse({ limit: "500" }).success, false);
  assert.equal(routeInternals.paginationQuerySchema.safeParse({ offset: "-1" }).success, false);
});
