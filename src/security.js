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

export function getAdminToken() {
  return process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || "";
}

export function getAdminUsername() {
  return process.env.ADMIN_USERNAME || "admin";
}

export function adminSessionValue(token = getAdminToken()) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function isLocalHost(hostHeader = "") {
  const rawHost = String(hostHeader).toLowerCase();
  let host = rawHost;
  if (rawHost.startsWith("[")) {
    host = rawHost.slice(1, rawHost.indexOf("]"));
  } else if (rawHost !== "::1") {
    host = rawHost.split(":")[0];
  }

  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function verifyAdminAuth(headers = {}) {
  const token = getAdminToken();
  if (!token) {
    return { ok: false, reason: "admin_token_missing" };
  }

  const header = getHeader(headers, "authorization");
  const suppliedToken = getHeader(headers, "x-admin-token");
  const cookieToken = getCookie(headers, "nibachat_admin");
  if (cookieToken && safeStringEqual(cookieToken, adminSessionValue(token))) {
    return { ok: true, mode: "cookie" };
  }

  if (suppliedToken && safeStringEqual(suppliedToken, token)) {
    return { ok: true, mode: "token" };
  }

  if (!header) {
    return { ok: false, reason: "missing_admin_auth" };
  }

  const [scheme, value] = header.split(/\s+/, 2);
  if (/^bearer$/i.test(scheme) && safeStringEqual(value || "", token)) {
    return { ok: true, mode: "bearer" };
  }

  if (/^basic$/i.test(scheme) && value) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (separator >= 0 && username === getAdminUsername() && safeStringEqual(password, token)) {
      return { ok: true, mode: "basic" };
    }
  }

  return { ok: false, reason: "invalid_admin_auth" };
}

function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return "";
}

function getCookie(headers, name) {
  const cookieHeader = getHeader(headers, "cookie");
  if (!cookieHeader) return "";
  const cookies = String(cookieHeader).split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    const key = cookie.slice(0, separator);
    const value = cookie.slice(separator + 1);
    if (key === name) return decodeURIComponent(value);
  }
  return "";
}

export function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
