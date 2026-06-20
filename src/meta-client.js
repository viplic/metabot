import crypto from "node:crypto";
import { getAppSecret } from "./security.js";
import { decryptSecret, looksLikeEnvName } from "./secrets.js";
import { fetchWithTimeout } from "./http.js";

export function normalizeMetaPayload(payload) {
  const events = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    for (const event of entry.messaging || []) {
      if (shouldIgnoreMessagingEvent(event)) continue;

      const text = normalizeMessagingText(event);
      const attachments = normalizeMessageAttachments(event.message?.attachments);
      if (!event.sender?.id || (!text && !attachments.length)) continue;
      events.push({
        id: event.message?.mid || event.postback?.mid || crypto.randomUUID(),
        senderId: event.sender.id,
        recipientId: event.recipient?.id || entry.id || "",
        pageId: entry.id || event.recipient?.id || "",
        timestamp: event.timestamp || Date.now(),
        channelType: inferChannelType(payload, event),
        text,
        attachments
      });
    }

    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (shouldIgnoreChangeEvent(value)) continue;
      const text = value.message || value.text || value.comment || "";
      const attachments = normalizeChangeAttachments(value);
      const senderId = value.sender_id || value.from?.id;
      if (!senderId || (!text && !attachments.length)) continue;
      events.push({
        id: value.message_id || crypto.randomUUID(),
        senderId,
        recipientId: value.recipient_id || entry.id || "",
        pageId: entry.id || "",
        timestamp: value.timestamp || Date.now(),
        channelType: payload.object === "instagram" ? "instagram" : "messenger",
        text,
        attachments
      });
    }
  }

  return events;
}

function shouldIgnoreMessagingEvent(event) {
  return Boolean(
    event.delivery ||
    event.read ||
    event.account_linking ||
    event.message?.is_echo ||
    event.message?.is_deleted ||
    event.message?.is_unsupported ||
    event.standby
  );
}

function shouldIgnoreChangeEvent(value) {
  return Boolean(value.is_echo || value.is_deleted || value.read || value.delivery);
}

function normalizeMessagingText(event) {
  return (
    event.message?.text ||
    event.message?.quick_reply?.payload ||
    event.message?.quick_reply?.title ||
    event.postback?.payload ||
    event.postback?.title ||
    event.optin?.ref ||
    ""
  );
}

function normalizeMessageAttachments(attachments = []) {
  return attachments
    .map((attachment) => ({
      type: attachment.type || "file",
      url: attachment.payload?.url || "",
      mimeType: attachment.payload?.mime_type || guessMimeType(attachment.payload?.url)
    }))
    .filter((attachment) => attachment.url);
}

function normalizeChangeAttachments(value) {
  const candidates = [
    value.media,
    value.attachment,
    value.attachments,
    value.message?.attachments,
    value.message?.attachment
  ];

  return candidates
    .flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))
    .filter(Boolean)
    .map((attachment) => ({
      type: attachment.type || attachment.media_type || "file",
      url: attachment.url || attachment.media_url || attachment.payload?.url || "",
      mimeType: attachment.mime_type || attachment.payload?.mime_type || guessMimeType(attachment.url || attachment.media_url || attachment.payload?.url)
    }))
    .filter((attachment) => attachment.url);
}

function guessMimeType(url = "") {
  const pathname = new URL(url, "https://example.local").pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

export async function sendMetaText({ config, channel, recipientId, text }) {
  if (!channel?.sendEnabled) {
    return { skipped: true, reason: "channel_send_disabled" };
  }

  const { accessToken, source } = getPageAccessToken(config, channel);
  if (!accessToken) {
    return { skipped: true, reason: `missing_${source}` };
  }

  const version = config.meta.graphApiVersion || "v25.0";
  const url = new URL(`https://graph.facebook.com/${version}/me/messages`);
  url.searchParams.set("access_token", accessToken);

  const appSecret = getAppSecret(config);
  if (appSecret) {
    const appSecretProof = crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
    url.searchParams.set("appsecret_proof", appSecretProof);
  }

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text }
    })
  }, Number(config.meta.sendTimeoutMs || 10000));

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Meta send failed: ${response.status} ${body}`);
  }

  return { skipped: false, response: body ? JSON.parse(body) : {} };
}

export async function fetchMetaUserProfile({ config, channel, platformUserId }) {
  const { accessToken } = getPageAccessToken(config, channel);
  if (!accessToken) return null;

  const version = config.meta.graphApiVersion || "v25.0";
  const url = new URL(`https://graph.facebook.com/${version}/${platformUserId}`);
  
  const fields = channel.type === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);

  const appSecret = getAppSecret(config);
  if (appSecret) {
    const appSecretProof = crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
    url.searchParams.set("appsecret_proof", appSecretProof);
  }

  try {
    const response = await fetchWithTimeout(url, {}, Number(config.meta.profileTimeoutMs || 5000));
    if (!response.ok) {
      console.warn(`Meta profile fetch failed: ${response.status} ${await response.text()}`);
      return null;
    }
    const data = await response.json();
    if (channel.type === "instagram") {
      return {
        name: data.name || data.username || "",
        avatar: data.profile_pic || "",
        username: data.username || ""
      };
    } else {
      return {
        name: [data.first_name, data.last_name].filter(Boolean).join(" ") || "",
        avatar: data.profile_pic || ""
      };
    }
  } catch (error) {
    console.error("Error fetching Meta user profile:", error);
    return null;
  }
}

export function getPageAccessToken(config, channel = {}) {
  const storedToken = decryptSecret(
    channel.pageAccessTokenEncrypted ||
      channel.pageAccessTokenSecret ||
      config.meta?.pageAccessTokenEncrypted ||
      config.meta?.pageAccessTokenSecret ||
      ""
  );
  if (storedToken) return { accessToken: storedToken, source: "stored_page_access_token" };

  const tokenEnv = channel.pageAccessTokenEnv || config.meta?.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
  if (tokenEnv && !looksLikeEnvName(tokenEnv)) {
    return { accessToken: tokenEnv, source: "stored_legacy_page_access_token" };
  }
  return { accessToken: process.env[tokenEnv] || "", source: tokenEnv };
}

export function findChannel(config, incoming) {
  const exactPage = config.channels.find(
    (channel) => channel.enabled && channel.pageId && channel.pageId === incoming.pageId
  );
  if (exactPage) return exactPage;

  const exactInstagram = config.channels.find(
    (channel) =>
      channel.enabled &&
      channel.type === "instagram" &&
      channel.igAccountId &&
      (channel.igAccountId === incoming.pageId || channel.igAccountId === incoming.recipientId)
  );
  if (exactInstagram) return exactInstagram;

  const byType = config.channels.find((channel) => channel.enabled && channel.type === incoming.channelType);
  return byType || config.channels.find((channel) => channel.enabled) || null;
}

function inferChannelType(payload, event) {
  if (payload.object === "instagram") return "instagram";
  if (event.message?.is_unsupported) return "instagram";
  return "messenger";
}
