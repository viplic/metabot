import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

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
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tenants = await readTenantsFile();
  if (tenants.length) return tenants;

  const now = new Date().toISOString();
  const initial = [
    {
      id: DEFAULT_TENANT_ID,
      name: "Moj servis",
      ownerEmail: "",
      status: "active",
      plan: "owner",
      portalEnabled: true,
      portalPasswordHash: hashPortalPassword(process.env.ADMIN_TOKEN || "change-this-admin-token"),
      createdAt: now,
      updatedAt: now
    }
  ];
  await saveTenants(initial);
  return initial;
}

export async function saveTenants(tenants) {
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
  const tenant = normalizeTenant({
    id,
    name: input.name || `Klijent ${tenants.length + 1}`,
    ownerEmail: input.ownerEmail || "",
    status: input.status || "active",
    plan: input.plan || "client",
    portalEnabled: true,
    portalPasswordHash: hashPortalPassword(input.portalPassword || generatePortalPassword()),
    createdAt: now,
    updatedAt: now
  });

  tenants.push(tenant);
  await saveTenants(tenants);

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
  tenant.portalPasswordHash = hashPortalPassword(password);
  tenant.updatedAt = new Date().toISOString();
  await saveTenants(tenants);
  return { tenantId: id, password };
}

export async function verifyTenantPortalAccess(tenantId, password) {
  const id = normalizeTenantId(tenantId);
  const tenants = await loadTenants();
  const tenant = tenants.find((item) => item.id === id);
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
    const config = normalizeConfig({
      ...defaults,
      business: {
        ...defaults.business,
        name: tenant?.name || id
      },
      ai: {
        ...defaults.ai,
        apiKeyEnv: `OPENAI_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
      }
    });
    await saveTenantConfig(id, config);
    return config;
  }
}

export async function saveTenantConfig(tenantId = DEFAULT_TENANT_ID, config) {
  const id = normalizeTenantId(tenantId);
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
  normalized.ai.maxInputChars = Number(normalized.ai.maxInputChars || 2000);
  normalized.ai.maxOutputTokens = Number(normalized.ai.maxOutputTokens || 500);
  normalized.ai.maxContextChars = Number(normalized.ai.maxContextChars || 4000);
  normalized.ai.maxHistoryChars = Number(normalized.ai.maxHistoryChars || 1600);
  normalized.ai.maxImages = Number(normalized.ai.maxImages || 3);
  normalized.ai.maxImageBytes = Number(normalized.ai.maxImageBytes || 5 * 1024 * 1024);
  normalized.ai.temperature = clampNumber(normalized.ai.temperature ?? 0.2, 0, 2);
  normalized.ai.modelRouting = {
    enabled: normalized.ai.modelRouting?.enabled !== false,
    simpleModel: normalized.ai.modelRouting?.simpleModel || "gpt-5.4-nano",
    standardModel: normalized.ai.modelRouting?.standardModel || "gpt-5.4-mini",
    complexModel: normalized.ai.modelRouting?.complexModel || "gpt-5.5",
    visionModel: normalized.ai.modelRouting?.visionModel || "gpt-5.5",
    standardMinChars: Number(normalized.ai.modelRouting?.standardMinChars || 220),
    complexMinChars: Number(normalized.ai.modelRouting?.complexMinChars || 900),
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
  normalized.privacy.retentionDays = Number(normalized.privacy.retentionDays || 90);

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
  return {
    id: normalizeTenantId(tenant.id),
    name: tenant.name || tenant.id || "Klijent",
    ownerEmail: tenant.ownerEmail || "",
    status: tenant.status || "active",
    plan: tenant.plan || "client",
    portalEnabled: tenant.portalEnabled !== false,
    portalPasswordHash: tenant.portalPasswordHash || "",
    createdAt: tenant.createdAt || now,
    updatedAt: tenant.updatedAt || now
  };
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
