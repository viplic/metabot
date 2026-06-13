import crypto from "node:crypto";

export function getVerifyToken(config) {
  return process.env.META_VERIFY_TOKEN || config.meta.verifyToken;
}

export function getAppSecret(config) {
  const envName = config.meta.appSecretEnv || "META_APP_SECRET";
  return process.env[envName] || process.env.META_APP_SECRET || "";
}

export function shouldRequireSignature(config) {
  if (process.env.META_REQUIRE_SIGNATURE) {
    return process.env.META_REQUIRE_SIGNATURE === "true";
  }
  return Boolean(config.meta.requireSignature);
}

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!signature) return false;
  if (!appSecret) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

export function redactValue(value, enabled = true) {
  if (!enabled || typeof value !== "string") return value;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[phone]");
}
