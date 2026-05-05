import crypto from "crypto";

const ENCRYPTION_PREFIX = "enc:v1:";
let warnedAboutFallbackKey = false;

function getKeyMaterial(): string {
  const key = process.env.SECRET_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!process.env.SECRET_ENCRYPTION_KEY && process.env.NODE_ENV === "production") {
    throw new Error("SECRET_ENCRYPTION_KEY must be set in production");
  }

  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SECRET_ENCRYPTION_KEY must be set in production");
    }
    return "development-only-secret-encryption-key";
  }

  if (!process.env.SECRET_ENCRYPTION_KEY && !warnedAboutFallbackKey) {
    warnedAboutFallbackKey = true;
    console.warn("SECRET_ENCRYPTION_KEY is not set; falling back to SESSION_SECRET");
  }

  return key;
}

function getEncryptionKey(): Buffer {
  const material = getKeyMaterial().trim();

  if (/^[a-f0-9]{64}$/i.test(material)) {
    return Buffer.from(material, "hex");
  }

  try {
    const decoded = Buffer.from(material, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // Fall back to hashing arbitrary key material below.
  }

  return crypto.createHash("sha256").update(material).digest();
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}

export function encryptSecret(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "" || isEncryptedSecret(value)) {
    return value;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${[
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")}`;
}

export function decryptSecret(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "" || !isEncryptedSecret(value)) {
    return value;
  }

  const [, rawPayload] = value.split(ENCRYPTION_PREFIX);
  const payload = rawPayload.startsWith(".") ? rawPayload.slice(1) : rawPayload;
  const [ivRaw, tagRaw, ciphertextRaw] = payload.split(".");
  if (!ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Invalid encrypted secret format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isSecretSettingKey(key: string): boolean {
  return /(PASS|PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)$/i.test(key);
}
