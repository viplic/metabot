import crypto from "node:crypto";

export function normalizeMetaPayload(payload) {
  const events = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    for (const event of entry.messaging || []) {
      const text = event.message?.text || event.postback?.title || "";
      if (!event.sender?.id || !text) continue;
      events.push({
        id: event.message?.mid || event.postback?.mid || crypto.randomUUID(),
        senderId: event.sender.id,
        recipientId: event.recipient?.id || entry.id || "",
        pageId: entry.id || event.recipient?.id || "",
        timestamp: event.timestamp || Date.now(),
        channelType: inferChannelType(payload, event),
        text
      });
    }

    for (const change of entry.changes || []) {
      const value = change.value || {};
      const text = value.message || value.text || value.comment || "";
      const senderId = value.sender_id || value.from?.id;
      if (!senderId || !text) continue;
      events.push({
        id: value.message_id || crypto.randomUUID(),
        senderId,
        recipientId: value.recipient_id || entry.id || "",
        pageId: entry.id || "",
        timestamp: value.timestamp || Date.now(),
        channelType: payload.object === "instagram" ? "instagram" : "messenger",
        text
      });
    }
  }

  return events;
}

export async function sendMetaText({ config, channel, recipientId, text }) {
  if (!channel?.sendEnabled) {
    return { skipped: true, reason: "channel_send_disabled" };
  }

  const tokenEnv = channel.pageAccessTokenEnv || config.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
  const accessToken = process.env[tokenEnv];
  if (!accessToken) {
    return { skipped: true, reason: `missing_${tokenEnv}` };
  }

  const version = config.meta.graphApiVersion || "v25.0";
  const url = new URL(`https://graph.facebook.com/${version}/me/messages`);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text }
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Meta send failed: ${response.status} ${body}`);
  }

  return { skipped: false, response: body ? JSON.parse(body) : {} };
}

export function findChannel(config, incoming) {
  const exactPage = config.channels.find(
    (channel) => channel.enabled && channel.pageId && channel.pageId === incoming.pageId
  );
  if (exactPage) return exactPage;

  const byType = config.channels.find((channel) => channel.enabled && channel.type === incoming.channelType);
  return byType || config.channels.find((channel) => channel.enabled) || null;
}

function inferChannelType(payload, event) {
  if (payload.object === "instagram") return "instagram";
  if (event.message?.is_unsupported) return "instagram";
  return "messenger";
}
