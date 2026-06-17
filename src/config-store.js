import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { getSql, hasDatabase, json } from "./db.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DEFAULT_CONFIG_PATH = path.resolve("data/default-config.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const TENANTS_PATH = path.join(DATA_DIR, "tenants.json");
const TENANT_CONFIG_DIR = path.join(DATA_DIR, "tenants");
export const DEFAULT_TENANT_ID = "default";

export async function loadConfig() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const defaults = await readJson(DEFAULT_CONFIG_PATH);

  try {
    const current = await readJson(CONFIG_PATH);
    return normalizeConfig(deepMerge(defaults, current));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveConfig(defaults);
    return normalizeConfig(defaults);
  }
}

export async function saveConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = normalizeConfig(config);
  const tempPath = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, CONFIG_PATH);
  return normalized;
}

export async function loadTenants() {
  if (hasDatabase()) {
    const sql = await getSql();
    const rows = await sql`
      SELECT id, name, owner_email, status, plan, portal_enabled, portal_password_hash,
             color, niche, signup_note, requested_at, approved_at, created_at, updated_at
      FROM tenants
      ORDER BY created_at ASC
    `;
    if (rows.length) return rows.map(dbTenantToTenant);
    const initial = [defaultTenant()];
    await saveTenants(initial);
    return initial;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tenants = await readTenantsFile();
  if (tenants.length) return tenants;

  const initial = [defaultTenant()];
  await saveTenants(initial);
  return initial;
}

export async function saveTenants(tenants) {
  if (hasDatabase()) {
    const sql = await getSql();
    const normalized = ensureArray(tenants).map(normalizeTenant);
    for (const tenant of normalized) {
      await upsertTenant(sql, tenant);
    }
    return normalized;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = ensureArray(tenants).map(normalizeTenant);
  const tempPath = `${TENANTS_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, TENANTS_PATH);
  return normalized;
}

export async function createTenant(input = {}) {
  const tenants = await loadTenants();
  const id = uniqueTenantId(input.id || input.name || "klijent", tenants);
  const now = new Date().toISOString();
  const portalPassword = input.portalPassword || generatePortalPassword();
  const shouldStorePortalPassword = Boolean(input.portalPassword) || input.status !== "pending";
  const tenant = normalizeTenant({
    id,
    name: input.name || `Klijent ${tenants.length + 1}`,
    ownerEmail: input.ownerEmail || "",
    status: input.status || "active",
    plan: input.plan || "client",
    color: input.color || colorForTenant(id),
    niche: input.niche || "",
    signupNote: input.signupNote || "",
    portalEnabled: input.portalEnabled ?? input.status !== "pending",
    portalPasswordHash: shouldStorePortalPassword ? hashPortalPassword(portalPassword) : "",
    requestedAt: input.status === "pending" ? now : input.requestedAt,
    approvedAt: input.status === "active" ? now : input.approvedAt,
    createdAt: now,
    updatedAt: now
  });

  if (hasDatabase()) {
    const sql = await getSql();
    await upsertTenant(sql, tenant);
  } else {
    tenants.push(tenant);
    await saveTenants(tenants);
  }

  const defaults = normalizeConfig(await readJson(DEFAULT_CONFIG_PATH));
  const config = normalizeConfig({
    ...defaults,
    business: {
      ...defaults.business,
      name: tenant.name
    },
    ai: {
      ...defaults.ai,
      apiKeyEnv: `OPENAI_API_KEY_${tenant.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    }
  });
  await saveTenantConfig(tenant.id, config);
  return { ...tenant, portalPassword: shouldStorePortalPassword && input.status !== "pending" ? portalPassword : "" };
}

export async function submitTenantSignup(input = {}) {
  const password = String(input.password || "");
  const ownerEmail = String(input.ownerEmail || "").trim();
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    const error = new Error("Valid email is required.");
    error.statusCode = 400;
    error.code = "invalid_email";
    throw error;
  }
  if (password.length < 8) {
    const error = new Error("Password must have at least 8 characters.");
    error.statusCode = 400;
    error.code = "weak_password";
    throw error;
  }

  return createTenant({
    name: input.name,
    ownerEmail,
    niche: input.niche,
    signupNote: input.signupNote,
    portalPassword: password,
    status: "pending",
    plan: "client",
    portalEnabled: false
  });
}

export async function approveTenantSignup(tenantId) {
  const id = normalizeTenantId(tenantId);
  const tenants = await loadTenants();
  const tenant = tenants.find((item) => item.id === id);
  if (!tenant) {
    const error = new Error(`Tenant not found: ${id}`);
    error.statusCode = 404;
    error.code = "tenant_not_found";
    throw error;
  }
  tenant.status = "active";
  tenant.portalEnabled = true;
  const password = tenant.portalPasswordHash ? "" : generatePortalPassword();
  if (password) tenant.portalPasswordHash = hashPortalPassword(password);
  tenant.approvedAt = new Date().toISOString();
  tenant.updatedAt = tenant.approvedAt;
  await saveTenants(tenants);
  return { tenantId: id, password, tenant };
}

export async function rejectTenantSignup(tenantId) {
  const id = normalizeTenantId(tenantId);
  const tenants = await loadTenants();
  const tenant = tenants.find((item) => item.id === id);
  if (!tenant) {
    const error = new Error(`Tenant not found: ${id}`);
    error.statusCode = 404;
    error.code = "tenant_not_found";
    throw error;
  }
  tenant.status = "rejected";
  tenant.portalEnabled = false;
  tenant.updatedAt = new Date().toISOString();
  await saveTenants(tenants);
  return tenant;
}

export async function resetTenantPortalPassword(tenantId) {
  const id = normalizeTenantId(tenantId);
  const tenants = await loadTenants();
  const tenant = tenants.find((item) => item.id === id);
  if (!tenant) {
    const error = new Error(`Tenant not found: ${id}`);
    error.statusCode = 404;
    error.code = "tenant_not_found";
    throw error;
  }

  const password = generatePortalPassword();
  tenant.portalEnabled = true;
  tenant.status = "active";
  tenant.portalPasswordHash = hashPortalPassword(password);
  tenant.updatedAt = new Date().toISOString();
  await saveTenants(tenants);
  return { tenantId: id, password };
}

export async function verifyTenantPortalAccess(tenantId, password) {
  const login = String(tenantId || "").trim();
  const id = normalizeTenantId(login);
  const tenants = await loadTenants();
  const tenant = tenants.find((item) => item.id === id || item.ownerEmail.toLowerCase() === login.toLowerCase());
  if (!tenant || tenant.status !== "active" || tenant.portalEnabled === false) return null;
  if (!tenant.portalPasswordHash) return null;
  if (!safeStringEqual(hashPortalPassword(password), tenant.portalPasswordHash)) return null;
  return tenant;
}

export async function requireTenantPortalToken(headers = {}) {
  const tenantId = getHeader(headers, "x-tenant-id");
  const token = getHeader(headers, "x-tenant-token");
  const tenant = await verifyTenantPortalAccess(tenantId, token);
  if (!tenant) {
    const error = new Error("client_auth_required");
    error.statusCode = 401;
    error.code = "client_auth_required";
    throw error;
  }
  return tenant;
}

export async function loadTenantConfig(tenantId = DEFAULT_TENANT_ID) {
  const id = normalizeTenantId(tenantId);
  if (hasDatabase()) {
    const sql = await getSql();
    const defaults = await readJson(DEFAULT_CONFIG_PATH);
    const rows = await sql`SELECT config FROM tenant_configs WHERE tenant_id = ${id} LIMIT 1`;
    if (rows.length) return normalizeConfig(deepMerge(defaults, rows[0].config));
    const tenants = await loadTenants();
    const tenant = tenants.find((item) => item.id === id);
    if (!tenant && id !== DEFAULT_TENANT_ID) {
      const error = new Error(`Tenant not found: ${id}`);
      error.statusCode = 404;
      error.code = "tenant_not_found";
      throw error;
    }
    const config = tenantDefaultConfig(defaults, tenant || { id, name: "Moj servis" });
    await saveTenantConfig(id, config);
    return config;
  }

  if (id === DEFAULT_TENANT_ID) return loadConfig();

  await ensureTenantExists(id);
  await fs.mkdir(TENANT_CONFIG_DIR, { recursive: true });
  const defaults = await readJson(DEFAULT_CONFIG_PATH);
  const tenantPath = tenantConfigPath(id);
  try {
    const current = await readJson(tenantPath);
    return normalizeConfig(deepMerge(defaults, current));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const tenants = await loadTenants();
    const tenant = tenants.find((item) => item.id === id);
    const config = tenantDefaultConfig(defaults, tenant || { id, name: id });
    await saveTenantConfig(id, config);
    return config;
  }
}

export async function saveTenantConfig(tenantId = DEFAULT_TENANT_ID, config) {
  const id = normalizeTenantId(tenantId);
  if (hasDatabase()) {
    const sql = await getSql();
    const normalized = normalizeConfig(config);
    await sql`
      INSERT INTO tenant_configs (tenant_id, config, updated_at)
      VALUES (${id}, ${json(normalized)}::jsonb, now())
      ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
    `;
    return normalized;
  }

  if (id === DEFAULT_TENANT_ID) return saveConfig(config);

  await ensureTenantExists(id);
  await fs.mkdir(TENANT_CONFIG_DIR, { recursive: true });
  const normalized = normalizeConfig(config);
  const tempPath = `${tenantConfigPath(id)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, tenantConfigPath(id));
  return normalized;
}

export function normalizeTenantId(value) {
  return slugId(value || DEFAULT_TENANT_ID) || DEFAULT_TENANT_ID;
}

export function normalizeConfig(config) {
  const normalized = structuredClone(config);
  normalized.channels = ensureArray(normalized.channels).map((channel, index) => ({
    id: channel.id || `${channel.type || "channel"}-${index + 1}`,
    type: channel.type || "messenger",
    name: channel.name || channel.type || "Kanal",
    enabled: Boolean(channel.enabled),
    pageId: channel.pageId || "",
    igAccountId: channel.igAccountId || "",
    sendEnabled: Boolean(channel.sendEnabled),
    pageAccessTokenEnv: channel.pageAccessTokenEnv || normalized.meta?.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN"
  }));

  normalized.automation.rules = ensureArray(normalized.automation?.rules).map((rule, index) => ({
    id: rule.id || `rule-${Date.now()}-${index}`,
    enabled: rule.enabled !== false,
    name: rule.name || `Pravilo ${index + 1}`,
    keywords: ensureArray(rule.keywords).map(String).filter(Boolean),
    response: rule.response || "",
    confidence: clampNumber(rule.confidence ?? 0.9, 0, 1)
  }));

  normalized.automation.faqs = ensureArray(normalized.automation?.faqs).map((faq, index) => ({
    id: faq.id || `faq-${Date.now()}-${index}`,
    enabled: faq.enabled !== false,
    question: faq.question || `Pitanje ${index + 1}`,
    keywords: ensureArray(faq.keywords).map(String).filter(Boolean),
    answer: faq.answer || ""
  }));

  normalized.automation.collectFields = ensureArray(normalized.automation?.collectFields).map((field, index) => ({
    id: field.id || `field-${index + 1}`,
    label: field.label || field.id || `polje ${index + 1}`,
    enabled: field.enabled !== false,
    required: Boolean(field.required)
  }));

  normalized.automation.handoffKeywords = ensureArray(normalized.automation?.handoffKeywords).map(String).filter(Boolean);
  normalized.automation.riskyKeywords = ensureArray(normalized.automation?.riskyKeywords).map(String).filter(Boolean);
  normalized.automation.policyWindowHours = Number(normalized.automation.policyWindowHours || 24);
  normalized.automation.humanAgentWindowDays = Number(normalized.automation.humanAgentWindowDays || 7);
  normalized.automation.deduplicationWindowHours = Number(normalized.automation.deduplicationWindowHours || 48);
  normalized.automation.confidenceThreshold = clampNumber(normalized.automation.confidenceThreshold ?? 0.72, 0, 1);
  normalized.ai.maxInputChars = clampNumber(normalized.ai.maxInputChars || 1800, 200, 1800);
  normalized.ai.maxOutputTokens = clampNumber(normalized.ai.maxOutputTokens || 320, 120, 320);
  normalized.ai.maxContextChars = clampNumber(normalized.ai.maxContextChars || 2600, 600, 2600);
  normalized.ai.maxHistoryChars = clampNumber(normalized.ai.maxHistoryChars || 900, 0, 900);
  normalized.ai.maxImages = clampNumber(normalized.ai.maxImages || 2, 0, 2);
  normalized.ai.maxImageBytes = clampNumber(normalized.ai.maxImageBytes || 3 * 1024 * 1024, 128 * 1024, 3 * 1024 * 1024);
  normalized.ai.temperature = clampNumber(normalized.ai.temperature ?? 0.15, 0, 0.15);
  normalized.ai.systemPrompt = isolatedSystemPrompt(normalized.ai.systemPrompt);
  normalized.ai.modelRouting = {
    enabled: normalized.ai.modelRouting?.enabled !== false,
    simpleModel: normalized.ai.modelRouting?.simpleModel || "gpt-5.4-nano",
    standardModel: normalized.ai.modelRouting?.standardModel || "gpt-5.4-mini",
    complexModel: normalized.ai.modelRouting?.complexModel || "gpt-5.5",
    visionModel: normalized.ai.modelRouting?.visionModel || "gpt-5.5",
    standardMinChars: Math.max(280, clampNumber(normalized.ai.modelRouting?.standardMinChars || 280, 80, 500)),
    complexMinChars: Math.max(1200, clampNumber(normalized.ai.modelRouting?.complexMinChars || 1200, 500, 2000)),
    complexKeywords: ensureArray(normalized.ai.modelRouting?.complexKeywords).map(String).filter(Boolean)
  };
  normalized.catalog = {
    sourceUrl: normalized.catalog?.sourceUrl || "",
    autoRefreshEnabled: normalized.catalog?.autoRefreshEnabled !== false,
    refreshEveryHours: Number(normalized.catalog?.refreshEveryHours || 24),
    lastRefreshAt: normalized.catalog?.lastRefreshAt || "",
    maxPages: Number(normalized.catalog?.maxPages || 8),
    products: ensureArray(normalized.catalog?.products),
    policies: ensureArray(normalized.catalog?.policies)
  };
  normalized.orders = {
    enabled: normalized.orders?.enabled !== false,
    requiredFields: ensureArray(normalized.orders?.requiredFields).length
      ? ensureArray(normalized.orders.requiredFields)
      : ["name", "phone", "street", "city", "postalCode", "product"],
    optionalFields: ensureArray(normalized.orders?.optionalFields).length
      ? ensureArray(normalized.orders.optionalFields)
      : ["color", "model", "quantity", "note"],
    captureComplaints: normalized.orders?.captureComplaints !== false
  };
  normalized.usage = {
    monthlyLimitUsd: Number(normalized.usage?.monthlyLimitUsd || 20),
    warnAtPercent: Number(normalized.usage?.warnAtPercent || 80)
  };
  normalized.integrations = normalized.integrations || {};
  normalized.integrations.googleSheets = {
    enabled: Boolean(normalized.integrations.googleSheets?.enabled),
    webhookUrlEnv: normalized.integrations.googleSheets?.webhookUrlEnv || "",
    webhookUrl: normalized.integrations.googleSheets?.webhookUrl || "",
    sheetUrl: normalized.integrations.googleSheets?.sheetUrl || ""
  };
  normalized.knowledge = normalized.knowledge || {};
  normalized.knowledge.enabled = normalized.knowledge.enabled !== false;
  normalized.knowledge.minScore = clampNumber(normalized.knowledge.minScore ?? 0.35, 0, 1);
  normalized.knowledge.autoReplyThreshold = clampNumber(normalized.knowledge.autoReplyThreshold ?? 0.82, 0, 1);
  normalized.knowledge.maxMatches = Number(normalized.knowledge.maxMatches || 4);
  normalized.knowledge.documents = ensureArray(normalized.knowledge.documents).map((document, index) => ({
    id: document.id || `knowledge-${Date.now()}-${index}`,
    enabled: document.enabled !== false,
    title: document.title || `Dokument ${index + 1}`,
    keywords: ensureArray(document.keywords).map(String).filter(Boolean),
    content: document.content || "",
    response: document.response || ""
  }));
  normalized.privacy.retentionDays = Number(normalized.privacy.retentionDays || 30);

  return normalized;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function isolatedSystemPrompt(value) {
  const prompt = String(value || "").trim();
  const isolation = "Koristi samo podatke ovog klijenta, njegov katalog, pravila, FAQ, bazu znanja i ovaj razgovor. Nikad ne koristi informacije drugih klijenata ili drugih shopova.";
  if (prompt.includes("Nikad ne koristi informacije drugih klijenata")) return prompt;
  return [prompt, isolation].filter(Boolean).join(" ");
}

async function readTenantsFile() {
  try {
    const raw = await fs.readFile(TENANTS_PATH, "utf8");
    const data = JSON.parse(raw);
    return ensureArray(data).map(normalizeTenant);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function ensureTenantExists(tenantId) {
  const tenants = await loadTenants();
  if (!tenants.some((tenant) => tenant.id === tenantId)) {
    const error = new Error(`Tenant not found: ${tenantId}`);
    error.statusCode = 404;
    error.code = "tenant_not_found";
    throw error;
  }
}

function normalizeTenant(tenant) {
  const now = new Date().toISOString();
  const id = normalizeTenantId(tenant.id);
  return {
    id,
    name: tenant.name || tenant.id || "Klijent",
    ownerEmail: tenant.ownerEmail || "",
    status: tenant.status || "active",
    plan: tenant.plan || "client",
    color: tenant.color || colorForTenant(id),
    niche: tenant.niche || "",
    signupNote: tenant.signupNote || tenant.signup_note || "",
    portalEnabled: tenant.portalEnabled !== false,
    portalPasswordHash: tenant.portalPasswordHash || "",
    requestedAt: tenant.requestedAt || tenant.requested_at || null,
    approvedAt: tenant.approvedAt || tenant.approved_at || null,
    createdAt: tenant.createdAt || now,
    updatedAt: tenant.updatedAt || now
  };
}

function tenantDefaultConfig(defaults, tenant) {
  const id = normalizeTenantId(tenant.id);
  return normalizeConfig({
    ...defaults,
    business: {
      ...defaults.business,
      name: tenant?.name || id,
      shortDescription: tenant?.niche || defaults.business?.shortDescription || ""
    },
    privacy: {
      ...(defaults.privacy || {}),
      retentionDays: 30
    },
    ai: {
      ...defaults.ai,
      apiKeyEnv: `OPENAI_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    }
  });
}

async function upsertTenant(sql, tenant) {
  await sql`
    INSERT INTO tenants (
      id, name, owner_email, status, plan, portal_enabled, portal_password_hash,
      color, niche, signup_note, requested_at, approved_at, created_at, updated_at
    )
    VALUES (
      ${tenant.id}, ${tenant.name}, ${tenant.ownerEmail}, ${tenant.status}, ${tenant.plan},
      ${tenant.portalEnabled}, ${tenant.portalPasswordHash}, ${tenant.color}, ${tenant.niche},
      ${tenant.signupNote}, ${tenant.requestedAt}, ${tenant.approvedAt}, ${tenant.createdAt}, ${tenant.updatedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      owner_email = EXCLUDED.owner_email,
      status = EXCLUDED.status,
      plan = EXCLUDED.plan,
      portal_enabled = EXCLUDED.portal_enabled,
      portal_password_hash = EXCLUDED.portal_password_hash,
      color = EXCLUDED.color,
      niche = EXCLUDED.niche,
      signup_note = EXCLUDED.signup_note,
      requested_at = EXCLUDED.requested_at,
      approved_at = EXCLUDED.approved_at,
      updated_at = now()
  `;
}

function dbTenantToTenant(row) {
  return normalizeTenant({
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    status: row.status,
    plan: row.plan,
    portalEnabled: row.portal_enabled,
    portalPasswordHash: row.portal_password_hash,
    color: row.color,
    niche: row.niche,
    signupNote: row.signup_note,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function colorForTenant(value) {
  const palette = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#f97316"];
  const text = String(value || "");
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function defaultTenant() {
  const now = new Date().toISOString();
  return normalizeTenant({
    id: DEFAULT_TENANT_ID,
    name: "Moj servis",
    ownerEmail: "",
    status: "active",
    plan: "owner",
    color: "#10b981",
    niche: "master",
    portalEnabled: true,
    portalPasswordHash: hashPortalPassword(process.env.ADMIN_TOKEN || "change-this-admin-token"),
    approvedAt: now,
    createdAt: now,
    updatedAt: now
  });
}

function uniqueTenantId(value, tenants) {
  const base = slugId(value) || "klijent";
  const existing = new Set(tenants.map((tenant) => tenant.id));
  if (!existing.has(base)) return base;

  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function tenantConfigPath(tenantId) {
  return path.join(TENANT_CONFIG_DIR, `${normalizeTenantId(tenantId)}.config.json`);
}

function slugId(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function generatePortalPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

function hashPortalPassword(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return "";
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
