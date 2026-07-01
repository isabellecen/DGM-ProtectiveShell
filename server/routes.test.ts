import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { BACKUP_WEBHOOK_PATH, PROXMOX_WEBHOOK_PATH } from "./backupWebhook";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { createBackupWebhookHandler, routeInternals } = await import("./routes");

type FakeWebhookStorage = NonNullable<Parameters<typeof createBackupWebhookHandler>[0]>;

function validWebhookBody() {
  return {
    source: "PVE",
    severity: "info",
    timestamp: 1730000000,
    title: "Backup succeeded",
    message: "OK",
    fields: {
      type: "vzdump",
      hostname: "pve1",
      "job-id": "backup-123",
    },
  };
}

async function postWebhook(options: {
  configuredSecret?: string | null;
  configuredBackupSecret?: string | null;
  configuredProxmoxSecret?: string | null;
  headerSecret?: string | null;
  headerName?: "authorization" | "x-secureshell-webhook-secret" | "x-protectiveshell-webhook-secret" | "x-webhook-secret";
  body?: unknown;
  ingestResult?: Awaited<ReturnType<NonNullable<FakeWebhookStorage["ingestBackupWebhookEvent"]>>>;
  path?: string;
} = {}) {
  const previousEnvSecret = process.env.PROXMOX_WEBHOOK_SECRET;
  const previousBackupEnvSecret = process.env.BACKUP_WEBHOOK_SECRET;
  delete process.env.PROXMOX_WEBHOOK_SECRET;
  delete process.env.BACKUP_WEBHOOK_SECRET;

  const ingestCalls: unknown[] = [];
  const fakeStorage: FakeWebhookStorage = {
    getSettingValue: async (key) => {
      if (options.configuredSecret === null) return undefined;
      if (key === "BACKUP_WEBHOOK_SECRET") {
        if ("configuredBackupSecret" in options) return options.configuredBackupSecret ?? undefined;
        return options.configuredSecret ?? "secret";
      }
      if (key === "PROXMOX_WEBHOOK_SECRET") {
        if ("configuredProxmoxSecret" in options) return options.configuredProxmoxSecret ?? undefined;
      }
      return undefined;
    },
    ingestBackupWebhookEvent: async (event) => {
      ingestCalls.push(event);
      return options.ingestResult ?? {
        status: "processed",
        jobId: 1,
        eventId: 2,
        expectedRunId: 3,
        eventStatus: "OK",
        duplicate: false,
      };
    },
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post(BACKUP_WEBHOOK_PATH, createBackupWebhookHandler(fakeStorage));
  app.post(PROXMOX_WEBHOOK_PATH, createBackupWebhookHandler(fakeStorage));
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const headerSecret = options.headerSecret === null ? undefined : options.headerSecret ?? "secret";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (headerSecret) {
      const headerName = options.headerName ?? "authorization";
      headers[headerName] = headerName === "authorization" ? `Bearer ${headerSecret}` : headerSecret;
    }

    const response = await fetch(`http://127.0.0.1:${port}${options.path ?? BACKUP_WEBHOOK_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? validWebhookBody()),
    });
    return {
      status: response.status,
      body: await response.json(),
      ingestCalls,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    if (previousEnvSecret === undefined) {
      delete process.env.PROXMOX_WEBHOOK_SECRET;
    } else {
      process.env.PROXMOX_WEBHOOK_SECRET = previousEnvSecret;
    }
    if (previousBackupEnvSecret === undefined) {
      delete process.env.BACKUP_WEBHOOK_SECRET;
    } else {
      process.env.BACKUP_WEBHOOK_SECRET = previousBackupEnvSecret;
    }
  }
}

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
  assert.equal(routeInternals.settingSchema.safeParse({ key: "BACKUP_WEBHOOK_SECRET", value: "secret" }).success, true);
  assert.equal(routeInternals.settingSchema.safeParse({ key: "PROXMOX_WEBHOOK_SECRET", value: "secret" }).success, true);
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

test("job webhook mapping validation requires a job id when source is set", () => {
  assert.throws(
    () => routeInternals.assertJobWebhookMappingValid({}, { webhookSource: "PVE", webhookJobId: "" }),
    /Webhook job ID is required/,
  );

  assert.doesNotThrow(() => routeInternals.assertJobWebhookMappingValid({}, {
    webhookSource: "PVE",
    webhookJobId: "backup-123",
  }));
  assert.doesNotThrow(() => routeInternals.assertJobWebhookMappingValid({}, {
    webhookSource: "DSM",
    webhookJobId: "CloudStation Backup",
  }));
});

test("job webhook mapping normalization clears stale fields when source is cleared", () => {
  assert.deepEqual(
    routeInternals.normalizeJobCreateData({
      webhookSource: null,
      webhookJobId: "backup-123",
      webhookHost: "pve1",
    }),
    {
      webhookSource: null,
      webhookJobId: null,
      webhookHost: null,
    },
  );

  assert.deepEqual(
    routeInternals.normalizeJobPatchData({
      webhookSource: null,
      webhookJobId: "backup-123",
      webhookHost: "pve1",
    }),
    {
      webhookSource: null,
      webhookJobId: null,
      webhookHost: null,
    },
  );
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

test("backup webhook route rejects missing and wrong secrets", async () => {
  assert.deepEqual(
    await postWebhook({ configuredSecret: null }),
    {
      status: 401,
      body: { message: "Invalid webhook secret" },
      ingestCalls: [],
    },
  );

  assert.deepEqual(
    await postWebhook({ headerSecret: null }),
    {
      status: 401,
      body: { message: "Invalid webhook secret" },
      ingestCalls: [],
    },
  );

  assert.deepEqual(
    await postWebhook({ headerSecret: "wrong" }),
    {
      status: 401,
      body: { message: "Invalid webhook secret" },
      ingestCalls: [],
    },
  );
});

test("backup webhook route accepts custom secret headers", async () => {
  assert.equal(
    (await postWebhook({ headerName: "x-secureshell-webhook-secret" })).status,
    200,
  );
  assert.equal(
    (await postWebhook({ headerName: "x-protectiveshell-webhook-secret" })).status,
    200,
  );
  assert.equal(
    (await postWebhook({ headerName: "x-webhook-secret" })).status,
    200,
  );
});

test("backup webhook route falls back to legacy Proxmox secret setting", async () => {
  const result = await postWebhook({
    configuredBackupSecret: null,
    configuredProxmoxSecret: "legacy-secret",
    headerSecret: "legacy-secret",
  });

  assert.equal(result.status, 200);
  assert.equal(result.ingestCalls.length, 1);
});

test("backup webhook route validates and ignores payloads", async () => {
  const malformed = await postWebhook({ body: { source: "PVE" } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.ingestCalls.length, 0);

  const unsupported = await postWebhook({
    body: {
      ...validWebhookBody(),
      fields: { type: "replication", "job-id": "replication-1" },
    },
  });
  assert.equal(unsupported.status, 202);
  assert.deepEqual(unsupported.body, {
    ok: true,
    ignored: true,
    reason: "unsupported PVE event type: replication",
  });
  assert.equal(unsupported.ingestCalls.length, 0);
});

test("backup webhook route returns ignored, processed, and duplicate ingest responses", async () => {
  const unmatched = await postWebhook({
    ingestResult: { status: "ignored", reason: "no matching backup job webhook mapping" },
  });
  assert.deepEqual(unmatched.body, {
    ok: true,
    ignored: true,
    reason: "no matching backup job webhook mapping",
  });
  assert.equal(unmatched.status, 202);
  assert.equal(unmatched.ingestCalls.length, 1);

  const matched = await postWebhook();
  assert.deepEqual(matched.body, {
    ok: true,
    status: "processed",
    jobId: 1,
    eventId: 2,
    expectedRunId: 3,
    eventStatus: "OK",
    duplicate: false,
  });
  assert.equal(matched.status, 200);

  const duplicate = await postWebhook({
    ingestResult: {
      status: "processed",
      jobId: 1,
      eventId: 2,
      expectedRunId: 3,
      eventStatus: "OK",
      duplicate: true,
    },
  });
  assert.deepEqual(duplicate.body, {
    ok: true,
    status: "processed",
    jobId: 1,
    eventId: 2,
    expectedRunId: 3,
    eventStatus: "OK",
    duplicate: true,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.ingestCalls.length, 1);
});

test("legacy Proxmox webhook route uses the backup webhook handler", async () => {
  const result = await postWebhook({ path: PROXMOX_WEBHOOK_PATH });

  assert.equal(result.status, 200);
  assert.equal(result.ingestCalls.length, 1);
});
