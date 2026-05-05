import type { Express, NextFunction, Request, Response } from "express";

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
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = clientKey(req, keyPrefix);
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds.toString());
      return res.status(429).json({ message: "Too many attempts. Try again shortly." });
    }

    return next();
  };
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

export function registerSecurity(app: Express) {
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      );
    }
    next();
  });

  app.use(rejectCrossOriginMutations);
  app.use(
    "/api/auth/login",
    createRateLimit({
      keyPrefix: "login",
      max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 8),
      windowMs: 15 * 60 * 1000,
    }),
  );
}
