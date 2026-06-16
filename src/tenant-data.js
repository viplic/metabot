import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const TENANT_DIR = path.join(DATA_DIR, "tenants");

export async function loadTenantStore(tenantId) {
  await fs.mkdir(TENANT_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(storePath(tenantId), "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const initial = normalizeStore({});
    await saveTenantStore(tenantId, initial);
    return initial;
  }
}

export async function saveTenantStore(tenantId, store) {
  await fs.mkdir(TENANT_DIR, { recursive: true });
  const normalized = normalizeStore(store);
  const tempPath = `${storePath(tenantId)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, storePath(tenantId));
  return normalized;
}

export async function upsertCatalogSnapshot(tenantId, snapshot) {
  const store = await loadTenantStore(tenantId);
  const now = new Date().toISOString();
  store.catalog = {
    sourceUrl: snapshot.sourceUrl,
    refreshedAt: now,
    pages: snapshot.pages || [],
    products: snapshot.products || [],
    policies: snapshot.policies || [],
    rawText: snapshot.rawText || ""
  };
  return saveTenantStore(tenantId, store);
}

export async function appendOrderRecord(tenantId, record) {
  const store = await loadTenantStore(tenantId);
  const now = new Date().toISOString();
  const normalized = {
    id: record.id || crypto.randomUUID(),
    type: record.type || "order",
    status: record.status || "new",
    source: record.source || "bot",
    platformUserId: record.platformUserId || "",
    conversationId: record.conversationId || "",
    customer: record.customer || {},
    product: record.product || {},
    delivery: record.delivery || {},
    complaint: record.complaint || {},
    notes: record.notes || "",
    missingFields: record.missingFields || [],
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  store.orders.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export async function appendUsageRecord(tenantId, record) {
  const store = await loadTenantStore(tenantId);
  const now = new Date().toISOString();
  const normalized = {
    id: record.id || crypto.randomUUID(),
    provider: record.provider || "openai",
    model: record.model || "",
    action: record.action || "ai_response",
    inputChars: Number(record.inputChars || 0),
    outputChars: Number(record.outputChars || 0),
    estimatedTokens: Number(record.estimatedTokens || estimateTokens(record.inputChars, record.outputChars)),
    estimatedCost: Number(record.estimatedCost || 0),
    createdAt: record.createdAt || now
  };
  store.usage.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export async function appendLearningMemory(tenantId, memory) {
  const store = await loadTenantStore(tenantId);
  const now = new Date().toISOString();
  const normalized = {
    id: memory.id || crypto.randomUUID(),
    status: memory.status || "review",
    question: memory.question || "",
    suggestedAnswer: memory.suggestedAnswer || "",
    source: memory.source || "conversation",
    createdAt: memory.createdAt || now
  };
  store.memories.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export function summarizeUsage(store, monthlyLimitUsd = 0) {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const month = store.usage.filter((item) => String(item.createdAt || "").startsWith(monthPrefix));
  const estimatedTokens = month.reduce((sum, item) => sum + Number(item.estimatedTokens || 0), 0);
  const estimatedCost = month.reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0);
  const percentUsed = monthlyLimitUsd > 0 ? Math.min(100, Math.round((estimatedCost / monthlyLimitUsd) * 100)) : 0;
  return {
    month: monthPrefix,
    requests: month.length,
    estimatedTokens,
    estimatedCost,
    monthlyLimitUsd,
    percentUsed,
    remainingUsd: monthlyLimitUsd > 0 ? Math.max(0, monthlyLimitUsd - estimatedCost) : null
  };
}

export function estimateTokens(inputChars = 0, outputChars = 0) {
  return Math.ceil((Number(inputChars || 0) + Number(outputChars || 0)) / 4);
}

function normalizeStore(store) {
  return {
    catalog: store.catalog || {
      sourceUrl: "",
      refreshedAt: null,
      pages: [],
      products: [],
      policies: [],
      rawText: ""
    },
    orders: Array.isArray(store.orders) ? store.orders : [],
    usage: Array.isArray(store.usage) ? store.usage : [],
    memories: Array.isArray(store.memories) ? store.memories : []
  };
}

function storePath(tenantId) {
  const safeId = String(tenantId || "default").replace(/[^a-z0-9_-]+/gi, "-");
  return path.join(TENANT_DIR, `${safeId}.store.json`);
}
