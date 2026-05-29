import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { securityInternals } = await import("./security");

test("HSTS is sent only for production HTTPS deployments", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCookieSecure = process.env.COOKIE_SECURE;
  const previousTrustProxy = process.env.TRUST_PROXY;

  try {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_SECURE = "1";
    process.env.TRUST_PROXY = "0";
    assert.equal(securityInternals.shouldSendHsts(), true);

    process.env.COOKIE_SECURE = "0";
    process.env.TRUST_PROXY = "1";
    assert.equal(securityInternals.shouldSendHsts(), true);

    process.env.NODE_ENV = "development";
    assert.equal(securityInternals.shouldSendHsts(), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCookieSecure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previousCookieSecure;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
  }
});

test("production CSP allows bundled font providers", () => {
  const csp = securityInternals.productionContentSecurityPolicy();

  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
});

test("login rate limit max falls back for invalid values", () => {
  const previous = process.env.LOGIN_RATE_LIMIT_MAX;

  try {
    process.env.LOGIN_RATE_LIMIT_MAX = "12";
    assert.equal(securityInternals.loginRateLimitMax(), 12);

    process.env.LOGIN_RATE_LIMIT_MAX = "0";
    assert.equal(securityInternals.loginRateLimitMax(), 8);

    process.env.LOGIN_RATE_LIMIT_MAX = "bad";
    assert.equal(securityInternals.loginRateLimitMax(), 8);

    process.env.LOGIN_RATE_LIMIT_MAX = "2.5";
    assert.equal(securityInternals.loginRateLimitMax(), 8);
  } finally {
    if (previous === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = previous;
  }
});
