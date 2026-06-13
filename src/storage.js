import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
const RAW_EVENTS_PATH = path.join(DATA_DIR, "raw-events.jsonl");

export async function loadConversations() {
  try {
    const raw = await fs.readFile(CONVERSATIONS_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveConversations(conversations) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${CONVERSATIONS_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(conversations, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, CONVERSATIONS_PATH);
}

export async function appendRawEvent(event) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(RAW_EVENTS_PATH, `${JSON.stringify(event)}\n`, "utf8");
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

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
