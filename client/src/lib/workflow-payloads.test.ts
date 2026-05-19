import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackupTargetPayload,
  buildEmailJobPayload,
  buildEmailLinkPayload,
  buildJobPayload,
  buildJobRulePayload,
  buildLoginPayload,
  buildNotificationRoutePayload,
  buildProxmoxHostPayload,
  buildRecipientPayload,
  buildSettingPayload,
} from "./workflow-payloads";
import { CLEAR_SECRET_SETTING_VALUE } from "@shared/settings";

test("login workflow sends entered credentials", () => {
  assert.deepEqual(buildLoginPayload("admin", "secret"), {
    username: "admin",
    password: "secret",
  });
});

test("job workflow normalizes schedule and customer fields", () => {
  assert.deepEqual(
    buildJobPayload({
      name: "Nightly",
      systemType: "VEEAM",
      customerId: "none",
      scheduleType: "daily",
      scheduleTime: "02:00",
      windowHours: "bad",
      enabled: true,
      longRunning: false,
      daysOfWeek: ["monday"],
    }),
    {
      name: "Nightly",
      systemType: "VEEAM",
      customerId: null,
      scheduleType: "daily",
      scheduleTime: "02:00",
      windowHours: 6,
      enabled: true,
      longRunning: false,
      longWindowHours: undefined,
      daysOfWeek: [],
    },
  );

  assert.deepEqual(
    buildJobPayload({
      name: "Weekly",
      systemType: "PBS",
      customerId: "7",
      scheduleType: "weekly",
      scheduleTime: "23:30",
      windowHours: "12",
      enabled: false,
      longRunning: true,
      longWindowHours: "72",
      daysOfWeek: ["friday"],
    }),
    {
      name: "Weekly",
      systemType: "PBS",
      customerId: 7,
      scheduleType: "weekly",
      scheduleTime: "23:30",
      windowHours: 12,
      enabled: false,
      longRunning: true,
      longWindowHours: 72,
      daysOfWeek: ["friday"],
    },
  );
});

test("target and host edit workflows preserve existing secrets when blank", () => {
  assert.equal(
    Object.hasOwn(
      buildBackupTargetPayload(
        {
          name: "PBS",
          type: "PBS",
          host: "10.0.0.5",
          port: "",
          username: "root@pam",
          password: "",
          tlsFingerprint: "",
          allowInsecureTls: false,
          customerId: "3",
          enabled: true,
        },
        true,
      ),
      "password",
    ),
    false,
  );

  assert.equal(
    Object.hasOwn(
      buildProxmoxHostPayload(
        {
          name: "PVE",
          host: "10.0.0.6",
          port: "",
          username: "root",
          password: "",
          hostKeyFingerprint: "",
          allowInsecureHostKey: false,
          customerId: "none",
          enabled: true,
        },
        true,
      ),
      "password",
    ),
    false,
  );
});

test("email and settings workflows build normalized API payloads", () => {
  assert.deepEqual(buildEmailLinkPayload("42"), { jobId: 42 });
  const job = buildJobPayload({
    name: "Nightly",
    systemType: "VEEAM",
    customerId: "none",
    scheduleType: "daily",
    scheduleTime: "02:00",
    windowHours: "6",
    enabled: true,
    longRunning: false,
    daysOfWeek: [],
  });
  assert.deepEqual(buildEmailJobPayload(job, true), {
    job,
    createRule: true,
  });
  assert.deepEqual(buildJobRulePayload({ jobId: 42, senderMatch: "backup@example.com" }), {
    jobId: 42,
    senderMatch: "backup@example.com",
    subjectMatch: null,
    bodyMatch: null,
    priority: 0,
  });
  assert.deepEqual(buildSettingPayload("IMAP_HOST", "mail.example.com"), {
    key: "IMAP_HOST",
    value: "mail.example.com",
  });
  assert.deepEqual(buildSettingPayload("IMAP_PASS", CLEAR_SECRET_SETTING_VALUE), {
    key: "IMAP_PASS",
    value: CLEAR_SECRET_SETTING_VALUE,
  });
});

test("recipient and notification route workflows normalize scoped ids", () => {
  assert.deepEqual(
    buildRecipientPayload({
      name: "Ops",
      email: "ops@example.com",
      type: "TECH",
      customerId: "none",
      enabled: true,
    }),
    {
      name: "Ops",
      email: "ops@example.com",
      type: "TECH",
      customerId: null,
      enabled: true,
    },
  );

  assert.deepEqual(
    buildNotificationRoutePayload({
      scopeType: "CUSTOMER",
      scopeId: "12",
      eventType: "FAIL",
      severityMin: "WARN",
      recipientIds: [1, 2],
    }),
    {
      scopeType: "CUSTOMER",
      scopeId: 12,
      eventType: "FAIL",
      severityMin: "WARN",
      recipientsJson: [1, 2],
    },
  );
});
