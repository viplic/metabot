import { promises as fs } from "node:fs";
import path from "node:path";
import { getSql, hasDatabase, json } from "./db.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
const RAW_EVENTS_PATH = path.join(DATA_DIR, "raw-events.jsonl");
const PROCESSED_EVENTS_PATH = path.join(DATA_DIR, "processed-events.json");
const TENANT_DATA_DIR = path.join(DATA_DIR, "tenants");
const DEFAULT_TENANT_ID = "default";

export async function loadConversations(tenantId = DEFAULT_TENANT_ID) {
  if (hasDatabase()) {
    const sql = await getSql();
    const rows = await sql`
      SELECT *
      FROM conversations
      WHERE tenant_id = ${normalizeTenantId(tenantId)}
      ORDER BY COALESCE(last_user_at, last_bot_at, opened_at) DESC
      LIMIT 500
    `;
    return rows.map(dbConversationToConversation);
  }

  try {
    const raw = await fs.readFile(conversationsPath(tenantId), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveConversations(conversations, tenantId = DEFAULT_TENANT_ID) {
  if (hasDatabase()) {
    const sql = await getSql();
    for (const conversation of conversations) {
      await sql`
        INSERT INTO conversations (
          id, tenant_id, platform_user_id, channel_type, status, human_handoff,
          profile, messages, audit, opened_at, last_user_at, last_bot_at
        )
        VALUES (
          ${conversation.id}, ${normalizeTenantId(tenantId)}, ${conversation.platformUserId || ""},
          ${conversation.channelType || ""}, ${conversation.status || "open"}, ${Boolean(conversation.humanHandoff)},
          ${json(conversation.profile || {})}::jsonb,
          ${json(conversation.messages || [])}::jsonb,
          ${json(conversation.audit || [])}::jsonb,
          ${conversation.openedAt || new Date().toISOString()},
          ${conversation.lastUserAt || null},
          ${conversation.lastBotAt || null}
        )
        ON CONFLICT (id) DO UPDATE SET
          platform_user_id = EXCLUDED.platform_user_id,
          channel_type = EXCLUDED.channel_type,
          status = EXCLUDED.status,
          human_handoff = EXCLUDED.human_handoff,
          profile = EXCLUDED.profile,
          messages = EXCLUDED.messages,
          audit = EXCLUDED.audit,
          last_user_at = EXCLUDED.last_user_at,
          last_bot_at = EXCLUDED.last_bot_at
      `;
    }
    return;
  }

  await fs.mkdir(path.dirname(conversationsPath(tenantId)), { recursive: true });
  const tempPath = `${conversationsPath(tenantId)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(conversations, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, conversationsPath(tenantId));
}

export async function appendRawEvent(event) {
  if (hasDatabase()) {
    const sql = await getSql();
    await sql`
      INSERT INTO raw_events (tenant_id, platform_user_id, payload, received_at)
      VALUES (
        ${normalizeTenantId(event.tenantId || DEFAULT_TENANT_ID)},
        ${event.platformUserId || ""},
        ${json(event)}::jsonb,
        ${event.receivedAt || new Date().toISOString()}
      )
    `;
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(RAW_EVENTS_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

export async function markEventIfNew(eventId, ttlHours = 48, tenantId = DEFAULT_TENANT_ID) {
  if (!eventId) return true;

  const scopedEventId = `${normalizeTenantId(tenantId)}:${eventId}`;
  const now = Date.now();
  const cutoff = now - Math.max(1, Number(ttlHours || 48)) * 60 * 60 * 1000;

  if (hasDatabase()) {
    const sql = await getSql();
    await sql`DELETE FROM processed_events WHERE processed_at < ${new Date(cutoff).toISOString()}`;
    try {
      await sql`
        INSERT INTO processed_events (id, tenant_id, processed_at)
        VALUES (${scopedEventId}, ${normalizeTenantId(tenantId)}, ${new Date(now).toISOString()})
      `;
      return true;
    } catch (error) {
      if (String(error.message || "").includes("duplicate") || error.code === "23505") return false;
      throw error;
    }
  }

  const processed = await loadProcessedEvents();

  for (const [id, timestamp] of Object.entries(processed)) {
    if (Date.parse(timestamp) < cutoff) {
      delete processed[id];
    }
  }

  if (processed[scopedEventId]) return false;

  processed[scopedEventId] = new Date(now).toISOString();
  await saveProcessedEvents(processed);
  return true;
}

export function findOrCreateConversation(conversations, incoming) {
  const platformUserId = incoming.senderId;
  const channelType = incoming.channelType;
  let conversation = conversations.find(
    (item) => item.platformUserId === platformUserId && item.channelType === channelType && item.status !== "deleted"
  );

  if (!conversation) {
    const now = new Date().toISOString();
    conversation = {
      id: cryptoRandomId(),
      platformUserId,
      channelType,
      status: "open",
      humanHandoff: false,
      profile: {},
      openedAt: now,
      lastUserAt: null,
      lastBotAt: null,
      messages: [],
      audit: []
    };
    conversations.unshift(conversation);
  }

  return conversation;
}

export function pruneExpiredConversations(conversations, retentionDays) {
  if (!retentionDays || retentionDays <= 0) return conversations;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return conversations.filter((conversation) => {
    const lastActivity = Date.parse(conversation.lastUserAt || conversation.openedAt || 0);
    return Number.isNaN(lastActivity) || lastActivity >= cutoff;
  });
}

export function deleteCustomerData(conversations, platformUserId) {
  const now = new Date().toISOString();
  let deleted = 0;

  const updated = conversations.map((conversation) => {
    if (conversation.platformUserId !== platformUserId) return conversation;
    deleted += 1;
    return {
      ...conversation,
      status: "deleted",
      platformUserId: `deleted-${conversation.id}`,
      profile: {},
      messages: [],
      audit: [
        ...(conversation.audit || []),
        {
          actor: "system",
          action: "privacy.delete_customer",
          createdAt: now
        }
      ]
    };
  });

  return { conversations: updated, deleted };
}

export async function pruneRawEvents(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (hasDatabase()) {
    const sql = await getSql();
    const result = await sql`DELETE FROM raw_events WHERE received_at < ${new Date(cutoff).toISOString()} RETURNING id`;
    await sql`DELETE FROM conversations WHERE opened_at < ${new Date(cutoff).toISOString()}`;
    return result.length;
  }
  return rewriteRawEvents((event) => {
    const receivedAt = Date.parse(event.receivedAt || 0);
    return Number.isNaN(receivedAt) || receivedAt >= cutoff;
  });
}

export async function deleteCustomerRawEvents(platformUserId) {
  if (!platformUserId) return 0;
  if (hasDatabase()) {
    const sql = await getSql();
    const result = await sql`DELETE FROM raw_events WHERE platform_user_id = ${platformUserId} RETURNING id`;
    return result.length;
  }
  return rewriteRawEvents((event, line) => !line.includes(platformUserId));
}

async function loadProcessedEvents() {
  try {
    const raw = await fs.readFile(PROCESSED_EVENTS_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveProcessedEvents(processed) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${PROCESSED_EVENTS_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(processed, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, PROCESSED_EVENTS_PATH);
}

async function rewriteRawEvents(shouldKeep) {
  let raw;
  try {
    raw = await fs.readFile(RAW_EVENTS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      kept.push(line);
      continue;
    }

    if (shouldKeep(event, line)) {
      kept.push(line);
    } else {
      removed += 1;
    }
  }

  if (removed > 0) {
    const tempPath = `${RAW_EVENTS_PATH}.tmp`;
    await fs.writeFile(tempPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    await fs.rename(tempPath, RAW_EVENTS_PATH);
  }

  return removed;
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function conversationsPath(tenantId) {
  const id = normalizeTenantId(tenantId);
  if (id === DEFAULT_TENANT_ID) return CONVERSATIONS_PATH;
  return path.join(TENANT_DATA_DIR, `${id}.conversations.json`);
}

function normalizeTenantId(value) {
  return String(value || DEFAULT_TENANT_ID)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_TENANT_ID;
}

function dbConversationToConversation(row) {
  return {
    id: row.id,
    platformUserId: row.platform_user_id,
    channelType: row.channel_type,
    status: row.status,
    humanHandoff: row.human_handoff,
    profile: row.profile || {},
    messages: row.messages || [],
    audit: row.audit || [],
    openedAt: row.opened_at,
    lastUserAt: row.last_user_at,
    lastBotAt: row.last_bot_at
  };
}
