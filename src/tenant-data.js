import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSql, hasDatabase, json } from "./db.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const TENANT_DIR = path.join(DATA_DIR, "tenants");

export async function loadTenantStore(tenantId) {
  if (hasDatabase()) {
    const sql = await getSql();
    const [catalog] = await sql`SELECT * FROM catalog_snapshots WHERE tenant_id = ${tenantId} LIMIT 1`;
    const orders = await sql`
      SELECT * FROM commerce_records
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const usage = await sql`
      SELECT * FROM usage_records
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 1000
    `;
    const memories = await sql`
      SELECT * FROM learning_memories
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
    return normalizeStore({
      catalog: catalog ? {
        sourceUrl: catalog.source_url,
        refreshedAt: catalog.refreshed_at,
        pages: catalog.pages || [],
        products: catalog.products || [],
        policies: catalog.policies || [],
        rawText: catalog.raw_text || ""
      } : null,
      orders: orders.map(dbOrderToRecord),
      usage: usage.map(dbUsageToRecord),
      memories: memories.map((row) => ({
        id: row.id,
        status: row.status,
        question: row.question,
        suggestedAnswer: row.suggested_answer,
        source: row.source,
        createdAt: row.created_at
      }))
    });
  }

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
  if (hasDatabase()) return normalizeStore(store);

  await fs.mkdir(TENANT_DIR, { recursive: true });
  const normalized = normalizeStore(store);
  const tempPath = `${storePath(tenantId)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, storePath(tenantId));
  return normalized;
}

export async function upsertCatalogSnapshot(tenantId, snapshot) {
  if (hasDatabase()) {
    const sql = await getSql();
    const now = new Date().toISOString();
    await sql`
      INSERT INTO catalog_snapshots (tenant_id, source_url, refreshed_at, pages, products, policies, raw_text)
      VALUES (
        ${tenantId}, ${snapshot.sourceUrl || ""}, ${now},
        ${json(snapshot.pages || [])}::jsonb,
        ${json(snapshot.products || [])}::jsonb,
        ${json(snapshot.policies || [])}::jsonb,
        ${snapshot.rawText || ""}
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        source_url = EXCLUDED.source_url,
        refreshed_at = EXCLUDED.refreshed_at,
        pages = EXCLUDED.pages,
        products = EXCLUDED.products,
        policies = EXCLUDED.policies,
        raw_text = EXCLUDED.raw_text
    `;
    return loadTenantStore(tenantId);
  }

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

  if (hasDatabase()) {
    const sql = await getSql();
    await sql`
      INSERT INTO commerce_records (
        id, tenant_id, type, status, source, platform_user_id, conversation_id,
        customer, product, delivery, complaint, notes, missing_fields, created_at, updated_at
      )
      VALUES (
        ${normalized.id}, ${tenantId}, ${normalized.type}, ${normalized.status}, ${normalized.source},
        ${normalized.platformUserId}, ${normalized.conversationId},
        ${json(normalized.customer)}::jsonb,
        ${json(normalized.product)}::jsonb,
        ${json(normalized.delivery)}::jsonb,
        ${json(normalized.complaint)}::jsonb,
        ${normalized.notes},
        ${json(normalized.missingFields)}::jsonb,
        ${normalized.createdAt}, ${normalized.updatedAt}
      )
    `;
    return normalized;
  }

  const store = await loadTenantStore(tenantId);
  store.orders.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export async function appendUsageRecord(tenantId, record) {
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

  if (hasDatabase()) {
    const sql = await getSql();
    await sql`
      INSERT INTO usage_records (
        id, tenant_id, provider, model, action, input_chars, output_chars,
        estimated_tokens, estimated_cost, created_at
      )
      VALUES (
        ${normalized.id}, ${tenantId}, ${normalized.provider}, ${normalized.model}, ${normalized.action},
        ${normalized.inputChars}, ${normalized.outputChars}, ${normalized.estimatedTokens},
        ${normalized.estimatedCost}, ${normalized.createdAt}
      )
    `;
    return normalized;
  }

  const store = await loadTenantStore(tenantId);
  store.usage.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export async function appendLearningMemory(tenantId, memory) {
  const now = new Date().toISOString();
  const normalized = {
    id: memory.id || crypto.randomUUID(),
    status: memory.status || "review",
    question: memory.question || "",
    suggestedAnswer: memory.suggestedAnswer || "",
    source: memory.source || "conversation",
    createdAt: memory.createdAt || now
  };

  if (hasDatabase()) {
    const sql = await getSql();
    await sql`
      INSERT INTO learning_memories (id, tenant_id, status, question, suggested_answer, source, created_at)
      VALUES (
        ${normalized.id}, ${tenantId}, ${normalized.status}, ${normalized.question},
        ${normalized.suggestedAnswer}, ${normalized.source}, ${normalized.createdAt}
      )
    `;
    return normalized;
  }

  const store = await loadTenantStore(tenantId);
  store.memories.unshift(normalized);
  await saveTenantStore(tenantId, store);
  return normalized;
}

export async function updateLearningMemory(tenantId, memoryId, updates = {}) {
  if (hasDatabase()) {
    const sql = await getSql();
    const rows = await sql`
      UPDATE learning_memories
      SET status = COALESCE(${updates.status || null}, status),
          question = COALESCE(${updates.question || null}, question),
          suggested_answer = COALESCE(${updates.suggestedAnswer || null}, suggested_answer),
          source = COALESCE(${updates.source || null}, source)
      WHERE tenant_id = ${tenantId} AND id = ${memoryId}
      RETURNING id, status, question, suggested_answer, source, created_at
    `;
    const row = rows[0];
    return row ? {
      id: row.id,
      status: row.status,
      question: row.question,
      suggestedAnswer: row.suggested_answer,
      source: row.source,
      createdAt: row.created_at
    } : null;
  }

  const store = await loadTenantStore(tenantId);
  const memory = store.memories.find((item) => item.id === memoryId);
  if (!memory) return null;
  Object.assign(memory, {
    ...("status" in updates ? { status: updates.status } : {}),
    ...("question" in updates ? { question: updates.question } : {}),
    ...("suggestedAnswer" in updates ? { suggestedAnswer: updates.suggestedAnswer } : {}),
    ...("source" in updates ? { source: updates.source } : {})
  });
  await saveTenantStore(tenantId, store);
  return memory;
}

export async function hasSimilarLearningMemory(tenantId, question) {
  const normalizedQuestion = normalizeLearningText(question);
  if (!normalizedQuestion) return true;

  const store = await loadTenantStore(tenantId);
  return store.memories.some((memory) => normalizeLearningText(memory.question) === normalizedQuestion);
}

export function normalizeLearningText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
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

function dbOrderToRecord(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    source: row.source,
    platformUserId: row.platform_user_id,
    conversationId: row.conversation_id,
    customer: row.customer || {},
    product: row.product || {},
    delivery: row.delivery || {},
    complaint: row.complaint || {},
    notes: row.notes || "",
    missingFields: row.missing_fields || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function dbUsageToRecord(row) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    action: row.action,
    inputChars: Number(row.input_chars || 0),
    outputChars: Number(row.output_chars || 0),
    estimatedTokens: Number(row.estimated_tokens || 0),
    estimatedCost: Number(row.estimated_cost || 0),
    createdAt: row.created_at
  };
}
