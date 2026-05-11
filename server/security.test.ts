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
