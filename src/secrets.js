import crypto from "node:crypto";

const ENCRYPTED_PREFIX = "enc:v1:";
export const SECRET_MASK = "••••••••";

export function encryptSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (isEncryptedSecret(text)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!isEncryptedSecret(text)) return text;

  const [, payload = ""] = text.split(ENCRYPTED_PREFIX);
  const [ivRaw, tagRaw, encryptedRaw] = payload.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

export function isEncryptedSecret(value) {
  return String(value || "").startsWith(ENCRYPTED_PREFIX);
}

export function hasStoredSecret(value) {
  return Boolean(String(value || "").trim());
}

export function shouldPreserveSecretInput(value) {
  const text = String(value || "").trim();
  return !text || text === SECRET_MASK;
}

export function looksLikeEnvName(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^EA[A-Za-z0-9_-]{20,}/.test(text)) return false;
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(text);
}

function secretKey() {
  const seed =
    process.env.SECRET_ENCRYPTION_KEY ||
    process.env.DATA_ENCRYPTION_KEY ||
    process.env.ADMIN_TOKEN ||
    process.env.ADMIN_PASSWORD ||
    process.env.DATABASE_URL ||
    "";

  if (!seed) {
    throw new Error("SECRET_ENCRYPTION_KEY is required to store dashboard secrets.");
  }

  return crypto.createHash("sha256").update(String(seed)).digest();
}
