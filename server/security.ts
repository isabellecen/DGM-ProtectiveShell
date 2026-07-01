import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { rateLimitHits } from "@shared/schema";
import { BACKUP_WEBHOOK_PATH, PROXMOX_WEBHOOK_PATH } from "./backupWebhook";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function clientKey(req: Request, prefix: string): string {
  return `${prefix}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function createRateLimit({ windowMs, max, keyPrefix }: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const nowDate = new Date(now);
    const key = clientKey(req, keyPrefix);
    const nextResetAt = new Date(now + windowMs);

    try {
      const [hit] = await db
        .insert(rateLimitHits)
        .values({ key, count: 1, resetAt: nextResetAt, updatedAt: nowDate })
        .onConflictDoUpdate({
          target: rateLimitHits.key,
          set: {
            count: sql`
              CASE
                WHEN ${rateLimitHits.resetAt} <= ${nowDate} THEN 1
                ELSE ${rateLimitHits.count} + 1
              END
            `,
            resetAt: sql`
              CASE
                WHEN ${rateLimitHits.resetAt} <= ${nowDate} THEN ${nextResetAt}
                ELSE ${rateLimitHits.resetAt}
              END
            `,
            updatedAt: nowDate,
          },
        })
        .returning();

      if (hit.count > max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAt.getTime() - now) / 1000));
        res.setHeader("Retry-After", retryAfterSeconds.toString());
        return res.status(429).json({ message: "Too many attempts. Try again shortly." });
      }
    } catch (err) {
      if (process.env.NODE_ENV === "production") {
        return next(err);
      }
      console.warn("Login rate limit unavailable:", err);
    }

    return next();
  };
}

function positiveIntegerFromValue(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loginRateLimitMax(): number {
  return positiveIntegerFromValue(process.env.LOGIN_RATE_LIMIT_MAX, 8);
}

function backupWebhookRateLimitMax(): number {
  return positiveIntegerFromValue(
    process.env.BACKUP_WEBHOOK_RATE_LIMIT_MAX || process.env.PROXMOX_WEBHOOK_RATE_LIMIT_MAX,
    300,
  );
}

export function enforceInsecureTargetPolicy() {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (process.env.ALLOW_PRODUCTION_INSECURE_TARGETS === "1") {
    return;
  }
  if (
    process.env.ALLOW_INSECURE_TARGET_TLS === "1" ||
    process.env.ALLOW_INSECURE_SSH_HOST_KEYS === "1"
  ) {
    throw new Error(
      "Production cannot enable insecure target TLS or SSH host-key bypasses unless ALLOW_PRODUCTION_INSECURE_TARGETS=1 is also set.",
    );
  }
}

function sameOrigin(req: Request, originHeader: string): boolean {
  try {
    const origin = new URL(originHeader);
    const forwardedHost = Array.isArray(req.headers["x-forwarded-host"])
      ? req.headers["x-forwarded-host"][0]
      : req.headers["x-forwarded-host"];
    const host = process.env.TRUST_PROXY === "1" ? forwardedHost || req.headers.host : req.headers.host;
    return !!host && origin.host === host;
  } catch {
    return false;
  }
}

function rejectCrossOriginMutations(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api") || !unsafeMethods.has(req.method)) {
    return next();
  }

  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return res.status(403).json({ message: "Cross-site requests are not allowed" });
  }

  const origin = req.get("origin");
  if (origin && !sameOrigin(req, origin)) {
    return res.status(403).json({ message: "Cross-origin requests are not allowed" });
  }

  return next();
}

function shouldSendHsts(): boolean {
  return process.env.NODE_ENV === "production" &&
    (process.env.COOKIE_SECURE === "1" || process.env.TRUST_PROXY === "1");
}

function productionContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function registerSecurity(app: Express) {
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Content-Security-Policy", productionContentSecurityPolicy());
      if (shouldSendHsts()) {
        res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
      }
    }
    next();
  });

  app.use(rejectCrossOriginMutations);
  app.use(
    "/api/auth/login",
    createRateLimit({
      keyPrefix: "login",
      max: loginRateLimitMax(),
      windowMs: 15 * 60 * 1000,
    }),
  );
  app.use(
    BACKUP_WEBHOOK_PATH,
    createRateLimit({
      keyPrefix: "backup-webhook",
      max: backupWebhookRateLimitMax(),
      windowMs: 15 * 60 * 1000,
    }),
  );
  app.use(
    PROXMOX_WEBHOOK_PATH,
    createRateLimit({
      keyPrefix: "backup-webhook",
      max: backupWebhookRateLimitMax(),
      windowMs: 15 * 60 * 1000,
    }),
  );
}

export const securityInternals = {
  shouldSendHsts,
  productionContentSecurityPolicy,
  loginRateLimitMax,
  backupWebhookRateLimitMax,
};
