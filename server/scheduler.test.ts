import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";
process.env.DISABLE_SCHEDULER = "1";

const { nextScheduledTimes, zonedWallTimeToUtc } = await import("./scheduler");

test("zonedWallTimeToUtc converts Phoenix wall time to UTC", () => {
  const date = zonedWallTimeToUtc(2026, 5, 5, 2, 30, "America/Phoenix");
  assert.equal(date.toISOString(), "2026-05-05T09:30:00.000Z");
});

test("nextScheduledTimes uses configured timezone and skips expired windows", () => {
  const job = {
    scheduleTime: "02:00",
    scheduleType: "daily",
    daysOfWeek: [],
    longRunning: false,
    longWindowHours: 24,
    windowHours: 6,
  };

  const times = nextScheduledTimes(job, new Date("2026-05-05T15:01:00.000Z"), "America/Phoenix");
  assert.deepEqual(times.map((time) => time.toISOString()), ["2026-05-06T09:00:00.000Z"]);
});

test("nextScheduledTimes respects weekly day selection", () => {
  const job = {
    scheduleTime: "22:00",
    scheduleType: "weekly",
    daysOfWeek: ["saturday"],
    longRunning: true,
    longWindowHours: 18,
    windowHours: 6,
  };

  const times = nextScheduledTimes(job, new Date("2026-05-09T18:00:00.000Z"), "America/Phoenix");
  assert.deepEqual(times.map((time) => time.toISOString()), ["2026-05-10T05:00:00.000Z"]);
});
