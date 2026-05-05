import assert from "node:assert/strict";
import test from "node:test";

process.env.SECRET_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { decryptSecret, encryptSecret, isEncryptedSecret, isSecretSettingKey } = await import("./crypto");

test("encryptSecret round trips values and marks encrypted payloads", () => {
  const encrypted = encryptSecret("super-secret");
  assert.equal(typeof encrypted, "string");
  assert.equal(isEncryptedSecret(encrypted), true);
  assert.equal(decryptSecret(encrypted), "super-secret");
});

test("encryptSecret is idempotent for encrypted values", () => {
  const encrypted = encryptSecret("super-secret");
  assert.equal(encryptSecret(encrypted), encrypted);
});

test("isSecretSettingKey detects common secret suffixes", () => {
  assert.equal(isSecretSettingKey("SMTP_PASS"), true);
  assert.equal(isSecretSettingKey("API_KEY"), true);
  assert.equal(isSecretSettingKey("APP_TIMEZONE"), false);
});
