import { and, eq, lt } from "drizzle-orm";
import { db } from "./db";
import { expectedRuns, incidents, jobs } from "@shared/schema";
import { pollImapInboxAndPersist } from "./emailPoller";
import {
  listEnabledBackupTargetIds,
  listEnabledProxmoxHostIds,
  pollBackupTargetAndPersist,
  runProxmoxHostCheck,
} from "./monitoring";
import { notifyOpenIncidents } from "./notificationService";
import { storage } from "./storage";

let started = false;

function intervalMs(envName: string, fallbackMinutes: number): number {
  const minutes = Number(process.env[envName] || fallbackMinutes);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
  return safeMinutes * 60 * 1000;
}

function schedule(name: string, interval: number, task: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) {
      console.warn(`${name} scheduler skipped because previous run is still active`);
      return;
    }
    running = true;
    try {
      await task();
    } catch (err) {
      console.error(`${name} scheduler failed:`, err);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, interval);
  timer.unref?.();
}

export function startScheduler() {
  if (started || process.env.NODE_ENV === "test" || process.env.DISABLE_SCHEDULER === "1") {
    return;
  }
  started = true;

  schedule("proxmox", intervalMs("PROXMOX_POLL_INTERVAL_MINUTES", 5), async () => {
    for (const hostId of await listEnabledProxmoxHostIds()) {
      await runProxmoxHostCheck(hostId);
    }
  });

  schedule("backup-target", intervalMs("BACKUP_TARGET_POLL_INTERVAL_MINUTES", 30), async () => {
    for (const targetId of await listEnabledBackupTargetIds()) {
      await pollBackupTargetAndPersist(targetId);
    }
  });

  schedule("imap", intervalMs("IMAP_POLL_INTERVAL_MINUTES", 60), pollImapInboxAndPersist);
  schedule("notifications", 5 * 60 * 1000, notifyOpenIncidents);
  schedule("expected-run-producer", 15 * 60 * 1000, produceExpectedRuns);
  schedule("expected-runs", 60 * 1000, evaluateExpectedRunDeadlines);
}

async function produceExpectedRuns() {
  const activeJobs = await db.select().from(jobs).where(eq(jobs.enabled, true));
  const now = new Date();
  const timezone = await getAppTimezone();

  for (const job of activeJobs) {
    for (const scheduledFor of nextScheduledTimes(job, now, timezone)) {
      const windowHours = job.longRunning ? job.longWindowHours || job.windowHours : job.windowHours;
      await db
        .insert(expectedRuns)
        .values({
          jobId: job.id,
          scheduledFor,
          deadlineAt: new Date(scheduledFor.getTime() + windowHours * 60 * 60 * 1000),
          status: "PENDING",
        })
        .onConflictDoNothing({
          target: [expectedRuns.jobId, expectedRuns.scheduledFor],
        });
    }
  }
}

export function nextScheduledTimes(
  job: Pick<typeof jobs.$inferSelect, "scheduleTime" | "scheduleType" | "daysOfWeek" | "longRunning" | "longWindowHours" | "windowHours">,
  now: Date,
  timezone = "UTC",
): Date[] {
  const times: Date[] = [];
  const [hoursRaw, minutesRaw] = job.scheduleTime.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return times;
  }

  for (let offset = 0; offset <= 1; offset++) {
    const localDate = addLocalDays(toZonedParts(now, timezone), offset);
    const scheduled = zonedWallTimeToUtc(
      localDate.year,
      localDate.month,
      localDate.day,
      hours,
      minutes,
      timezone,
    );

    if (job.scheduleType === "weekly") {
      const dayName = weekdayName(scheduled, timezone);
      if (!job.daysOfWeek?.map((day) => day.toLowerCase()).includes(dayName)) {
        continue;
      }
    }

    const windowHours = job.longRunning ? job.longWindowHours || job.windowHours : job.windowHours;
    const deadlineAt = new Date(scheduled.getTime() + windowHours * 60 * 60 * 1000);
    if (deadlineAt > now) {
      times.push(scheduled);
    }
  }

  return times;
}

async function evaluateExpectedRunDeadlines() {
  const now = new Date();
  const missingRuns = await db
    .update(expectedRuns)
    .set({ status: "MISSING" })
    .where(and(eq(expectedRuns.status, "PENDING"), lt(expectedRuns.deadlineAt, now)))
    .returning();

  for (const run of missingRuns) {
    await db
      .insert(incidents)
      .values({
        sourceType: "BACKUP",
        sourceId: run.jobId,
        severity: "CRIT",
        title: `Backup job #${run.jobId} missed its deadline`,
        details: `Expected run #${run.id} was due by ${run.deadlineAt.toISOString()}.`,
        state: "OPEN",
        sourceFingerprint: `expected-run:${run.id}:missing`,
      })
      .onConflictDoNothing({
        target: incidents.sourceFingerprint,
      });
  }
}

async function getAppTimezone(): Promise<string> {
  const configured =
    (await storage.getSettingValue("APP_TIMEZONE")) ||
    process.env.APP_TIMEZONE ||
    "UTC";
  return normalizeTimezone(configured);
}

function normalizeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "UTC";
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function toZonedParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function addLocalDays(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const actual = toZonedParts(guess, timezone);
  const wantedUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
  return new Date(guess.getTime() + (wantedUtc - actualUtc));
}

function weekdayName(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(date).toLowerCase();
}
