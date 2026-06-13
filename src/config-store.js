import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const DEFAULT_CONFIG_PATH = path.join(DATA_DIR, "default-config.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

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
  normalized.automation.confidenceThreshold = clampNumber(normalized.automation.confidenceThreshold ?? 0.72, 0, 1);
  normalized.ai.maxInputChars = Number(normalized.ai.maxInputChars || 2000);
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
