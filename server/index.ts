import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDatabase } from "./seed";
import { registerAuth } from "./auth";
import { registerAudit } from "./audit";
import { enforceInsecureTargetPolicy, registerSecurity } from "./security";
import { registerHealth } from "./health";
import { startScheduler } from "./scheduler";
import { pool } from "./db";
import { ZodError } from "zod";

const app = express();
const httpServer = createServer(app);
enforceInsecureTargetPolicy();
registerSecurity(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch (err) {
    const code = errorCode(err);
    const detail = code ? `${code}: ${errorMessage(err)}` : errorMessage(err);

    if (process.env.NODE_ENV === "production") {
      throw new Error(`Database connection failed: ${detail}`);
    }

    console.error(
      `Database unavailable (${detail}). Start PostgreSQL or update DATABASE_URL, then run npm run db:push and restart npm run dev. Skipping seed data and background schedulers for this process.`,
    );
    return false;
  }
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  const databaseReady = await checkDatabaseConnection();
  const schedulerEnabled =
    databaseReady && process.env.NODE_ENV !== "test" && process.env.DISABLE_SCHEDULER !== "1";

  if (databaseReady && process.env.SEED_ON_BOOT === "1") {
    await seedDatabase().catch((err) => {
      console.error("Seed error (non-fatal):", err.message);
    });
  }

  registerHealth(app, { schedulerEnabled });
  registerAuth(app);
  registerAudit(app);
  await registerRoutes(httpServer, app);
  if (schedulerEnabled) {
    startScheduler();
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const errorLike = err as { status?: number; statusCode?: number; message?: string };
    const status = err instanceof ZodError ? 400 : errorLike.status || errorLike.statusCode || 500;
    const message =
      err instanceof ZodError
        ? err.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")
        : status >= 500
          ? "Internal Server Error"
          : errorLike.message || "Internal Server Error";

    if (status >= 500) {
      console.error("Internal Server Error:", err);
    }

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "0.0.0.0";

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set PORT to a free port and restart.`);
      process.exit(1);
    }

    console.error("Server failed to start:", err.message);
    process.exit(1);
  });

  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
