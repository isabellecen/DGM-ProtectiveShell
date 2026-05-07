import type { Express } from "express";
import { pool } from "./db";
import { storage } from "./storage";

const workerStaleAfterMs: Record<string, number> = {
  proxmox: 30 * 60 * 1000,
  "backup-target": 2 * 60 * 60 * 1000,
  imap: 2 * 60 * 60 * 1000,
  notifications: 30 * 60 * 1000,
  "expected-run-producer": 45 * 60 * 1000,
  "expected-runs": 10 * 60 * 1000,
  retention: 30 * 60 * 60 * 1000,
  "daily-report": 10 * 60 * 1000,
};

type HealthOptions = {
  schedulerEnabled: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function databaseHealth() {
  const startedAt = Date.now();
  await pool.query("select 1");
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
  };
}

async function schedulerHealth(enabled: boolean) {
  if (!enabled) {
    return {
      enabled,
      ok: true,
      staleWorkers: [],
      errorWorkers: [],
    };
  }

  const now = Date.now();
  const runs = await storage.getSchedulerRuns();
  const staleWorkers = runs
    .filter((run) => {
      const staleAfter = workerStaleAfterMs[run.workerName];
      return staleAfter ? now - run.updatedAt.getTime() > staleAfter : false;
    })
    .map((run) => ({
      workerName: run.workerName,
      status: run.status,
      updatedAt: run.updatedAt,
    }));
  const errorWorkers = runs
    .filter((run) => run.status === "ERROR")
    .map((run) => ({
      workerName: run.workerName,
      message: run.message,
      updatedAt: run.updatedAt,
    }));

  return {
    enabled,
    ok: staleWorkers.length === 0,
    staleWorkers,
    errorWorkers,
  };
}

export function registerHealth(app: Express, options: HealthOptions) {
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      const database = await databaseHealth();
      const scheduler = await schedulerHealth(options.schedulerEnabled);
      const ok = database.ok && scheduler.ok;

      res.status(ok ? 200 : 503).json({
        ok,
        database,
        scheduler,
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        database: {
          ok: false,
          message: errorMessage(err),
        },
        scheduler: {
          enabled: options.schedulerEnabled,
          ok: false,
          staleWorkers: [],
          errorWorkers: [],
        },
      });
    }
  });
}
