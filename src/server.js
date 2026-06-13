import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config-store.js";
import { routeIncomingMessage, appendConversationMessages } from "./bot-engine.js";
import { getAppSecret, getVerifyToken, shouldRequireSignature, verifyMetaSignature } from "./security.js";
import { findChannel, normalizeMetaPayload, sendMetaText } from "./meta-client.js";
import {
  appendRawEvent,
  deleteCustomerData,
  findOrCreateConversation,
  loadConversations,
  pruneExpiredConversations,
  saveConversations
} from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/webhook") {
      return await handleWebhookVerify(url, response);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return await handleWebhookPost(request, response);
    }

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(request, response, url);
    }

    return await serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "internal_server_error", message: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Meta bot console: http://localhost:${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
});

async function handleWebhookVerify(url, response) {
  const config = await loadConfig();
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === getVerifyToken(config)) {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(challenge || "");
    return;
  }

  sendJson(response, 403, { error: "verification_failed" });
}

async function handleWebhookPost(request, response) {
  const config = await loadConfig();
  const rawBody = await readBody(request, 1024 * 1024);
  const signature = request.headers["x-hub-signature-256"];

  if (shouldRequireSignature(config) && !verifyMetaSignature(rawBody, signature, getAppSecret(config))) {
    sendJson(response, 403, { error: "invalid_signature" });
    return;
  }

  const payload = JSON.parse(rawBody.toString("utf8"));
  sendJson(response, 200, { ok: true });

  try {
    if (config.privacy.storeRawEvents) {
      await appendRawEvent({
        receivedAt: new Date().toISOString(),
        object: payload.object,
        payload
      });
    }

    const incomingEvents = normalizeMetaPayload(payload);
    if (!incomingEvents.length) return;

    let conversations = pruneExpiredConversations(await loadConversations(), config.privacy.retentionDays);

    for (const incoming of incomingEvents) {
      const channel = findChannel(config, incoming);
      if (!channel) continue;

      const conversation = findOrCreateConversation(conversations, incoming);
      const result = await routeIncomingMessage({
        text: incoming.text,
        config,
        conversation,
        channelType: channel.type
      });
      appendConversationMessages(conversation, incoming.text, result, config);
      await maybeOpenTicket(config, conversation, incoming, result);

      try {
        await sendMetaText({
          config,
          channel,
          recipientId: incoming.senderId,
          text: result.reply
        });
      } catch (error) {
        conversation.audit.push({
          actor: "meta",
          action: "send.failed",
          payload: { message: error.message },
          createdAt: new Date().toISOString()
        });
      }
    }

    await saveConversations(conversations);
  } catch (error) {
    console.error("Error processing webhook payload after response sent:", error);
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const config = await loadConfig();
    return sendJson(response, 200, {
      ok: true,
      graphApiVersion: config.meta.graphApiVersion,
      signatureRequired: shouldRequireSignature(config)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendJson(response, 200, await loadConfig());
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const saved = await saveConfig(body);
    return sendJson(response, 200, saved);
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    const conversations = pruneExpiredConversations(await loadConversations(), (await loadConfig()).privacy.retentionDays);
    await saveConversations(conversations);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && url.pathname === "/api/test-message") {
    const config = await loadConfig();
    const body = await readJsonBody(request);
    const conversation = {
      id: "test",
      platformUserId: "test-user",
      channelType: body.channelType || "messenger",
      profile: body.profile || {},
      messages: [],
      audit: []
    };
    const result = await routeIncomingMessage({
      text: body.text || "",
      config,
      conversation,
      channelType: body.channelType || "messenger"
    });
    return sendJson(response, 200, { result, conversation });
  }

  if (request.method === "POST" && url.pathname === "/api/privacy/delete-customer") {
    const body = await readJsonBody(request);
    const current = await loadConversations();
    const { conversations, deleted } = deleteCustomerData(current, body.platformUserId);
    await saveConversations(conversations);
    return sendJson(response, 200, { deleted });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function maybeOpenTicket(config, conversation, incoming, result) {
  if (result.action !== "handoff") return;
  if (!config.handoff.ticketing.enabled) return;

  const webhookUrl = process.env[config.handoff.ticketing.webhookUrlEnv || "TICKETING_WEBHOOK_URL"];
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversation.id,
        platformUserId: conversation.platformUserId,
        channelType: incoming.channelType,
        text: incoming.text,
        reason: result.reason,
        profile: conversation.profile
      })
    });

    conversation.audit.push({
      actor: "ticketing",
      action: response.ok ? "ticket.created" : "ticket.failed",
      payload: { status: response.status },
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    conversation.audit.push({
      actor: "ticketing",
      action: "ticket.failed",
      payload: { message: error.message },
      createdAt: new Date().toISOString()
    });
  }
}

async function serveStatic(url, response) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);

  if (!resolved.startsWith(PUBLIC_DIR)) {
    return sendJson(response, 403, { error: "forbidden" });
  }

  try {
    const file = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const file = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
      response.writeHead(200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" });
      response.end(file);
      return;
    }
    throw error;
  }
}

async function readJsonBody(request) {
  const body = await readBody(request, 1024 * 1024);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

async function readBody(request, limitBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("request_body_too_large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
