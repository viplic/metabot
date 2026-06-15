import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";
import { loadConfig, saveConfig } from "./config-store.js";
import { routeIncomingMessage, appendConversationMessages } from "./bot-engine.js";
import { getMetrics, incrementMetric, recordError, setGauge } from "./metrics.js";
import { checkRateLimit, getClientIp } from "./rate-limit.js";
import { evaluateReadiness } from "./readiness.js";
import {
  getAdminToken,
  getAppSecret,
  getVerifyToken,
  isLocalHost,
  redactValue,
  shouldRequireSignature,
  verifyAdminAuth,
  verifyMetaSignature
} from "./security.js";
import { findChannel, normalizeMetaPayload, sendMetaText, fetchMetaUserProfile } from "./meta-client.js";
import {
  appendRawEvent,
  deleteCustomerRawEvents,
  deleteCustomerData,
  findOrCreateConversation,
  loadConversations,
  markEventIfNew,
  pruneRawEvents,
  pruneExpiredConversations,
  saveConversations
} from "./storage.js";

await loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);
let webhookQueue = Promise.resolve();
let webhookQueueDepth = 0;

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
      if (!allowRequest(request, response, "webhook", Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE || 1000))) return;
      return await handleWebhookPost(request, response);
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health" && !allowRequest(request, response, "admin", Number(process.env.ADMIN_RATE_LIMIT_PER_MINUTE || 300))) return;
      if (url.pathname !== "/api/health" && !requireAdminAccess(request, response)) return;
      return await handleApi(request, response, url);
    }

    if (!requireAdminAccess(request, response)) return;
    return await serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      error: error.code || "internal_server_error",
      message: error.message
    });
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
    response.writeHead(200, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end(challenge || "");
    return;
  }

  sendJson(response, 403, { error: "verification_failed" });
}

async function handleWebhookPost(request, response) {
  incrementMetric("webhook.received");
  const config = await loadConfig();
  const rawBody = await readBody(request, 1024 * 1024);
  const signature = request.headers["x-hub-signature-256"];

  if (shouldRequireSignature(config) && !verifyMetaSignature(rawBody, signature, getAppSecret(config))) {
    incrementMetric("webhook.invalid_signature");
    sendJson(response, 403, { error: "invalid_signature" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    incrementMetric("webhook.invalid_json");
    sendJson(response, 400, { error: "invalid_json" });
    return;
  }

  sendJson(response, 200, { ok: true });
  enqueueWebhookJob(payload);
}

async function processWebhookPayload(payload) {
  try {
    const config = await loadConfig();
    await pruneRawEvents(config.privacy.retentionDays);

    if (config.privacy.storeRawEvents) {
      await appendRawEvent({
        receivedAt: new Date().toISOString(),
        object: payload.object,
        payload: config.privacy.redactLogs ? redactPayload(payload) : payload
      });
    }

    const incomingEvents = normalizeMetaPayload(payload);
    if (!incomingEvents.length) return;

    incrementMetric("webhook.events", incomingEvents.length);
    let conversations = pruneExpiredConversations(await loadConversations(), config.privacy.retentionDays);

    for (const incoming of incomingEvents) {
      const channel = findChannel(config, incoming);
      if (!channel) {
        incrementMetric("webhook.channel_miss");
        continue;
      }

      const isNewEvent = await markEventIfNew(
        incoming.id,
        config.automation.deduplicationWindowHours
      );
      if (!isNewEvent) {
        incrementMetric("webhook.duplicates");
        continue;
      }

      const conversation = findOrCreateConversation(conversations, incoming);
      if (!conversation.profile?.name) {
        const profileInfo = await fetchMetaUserProfile({ config, channel, platformUserId: incoming.senderId });
        if (profileInfo) {
          conversation.profile = { ...(conversation.profile || {}), ...profileInfo };
        }
      }
      const result = await routeIncomingMessage({
        text: incoming.text,
        config,
        conversation,
        channelType: channel.type,
        eventTimestamp: incoming.timestamp
      });
      appendConversationMessages(conversation, incoming.text, result, config);
      await maybeOpenTicket(config, conversation, incoming, result);

      if (result.sendAllowed !== false && result.reply) {
        try {
          const sendResult = await sendMetaText({
            config,
            channel,
            recipientId: incoming.senderId,
            text: result.reply
          });

          if (sendResult.skipped) {
            incrementMetric("meta.send.skipped");
            conversation.audit.push({
              actor: "meta",
              action: "send.skipped",
              payload: { reason: sendResult.reason },
              createdAt: new Date().toISOString()
            });
          } else {
            incrementMetric("meta.send.ok");
          }
        } catch (error) {
          incrementMetric("meta.send.failed");
          conversation.audit.push({
            actor: "meta",
            action: "send.failed",
            payload: { message: error.message },
            createdAt: new Date().toISOString()
          });
        }
      } else {
        incrementMetric("meta.send.blocked");
        conversation.audit.push({
          actor: "meta",
          action: "send.blocked",
          payload: { reason: result.reason },
          createdAt: new Date().toISOString()
        });
      }
    }

    await saveConversations(conversations);
  } catch (error) {
    recordError("webhook", error);
    console.error("Error processing webhook payload after response sent:", error);
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const config = await loadConfig();
    return sendJson(response, 200, {
      ok: true,
      graphApiVersion: config.meta.graphApiVersion,
      signatureRequired: shouldRequireSignature(config),
      adminProtected: Boolean(getAdminToken()),
      ready: evaluateReadiness(config).ready,
      queueDepth: webhookQueueDepth,
      uptimeSeconds: Math.round(process.uptime())
    });
  }

  if (request.method === "GET" && url.pathname === "/api/readiness") {
    return sendJson(response, 200, evaluateReadiness(await loadConfig()));
  }

  if (request.method === "GET" && url.pathname === "/api/metrics") {
    return sendJson(response, 200, getMetrics());
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
    const config = await loadConfig();
    const conversations = pruneExpiredConversations(await loadConversations(), config.privacy.retentionDays);
    await pruneRawEvents(config.privacy.retentionDays);
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
      channelType: body.channelType || "messenger",
      eventTimestamp: body.eventTimestamp || Date.now()
    });
    return sendJson(response, 200, { result, conversation });
  }

  if (request.method === "POST" && url.pathname === "/api/privacy/delete-customer") {
    const body = await readJsonBody(request);
    const current = await loadConversations();
    const { conversations, deleted } = deleteCustomerData(current, body.platformUserId);
    const rawEventsDeleted = await deleteCustomerRawEvents(body.platformUserId);
    await saveConversations(conversations);
    return sendJson(response, 200, { deleted, rawEventsDeleted });
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
    response.writeHead(200, securityHeaders({
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    }));
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const file = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
      response.writeHead(200, securityHeaders({ "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" }));
      response.end(file);
      return;
    }
    throw error;
  }
}

async function readJsonBody(request) {
  const body = await readBody(request, 1024 * 1024);
  try {
    return body.length ? JSON.parse(body.toString("utf8")) : {};
  } catch (error) {
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

async function readBody(request, limitBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error("request_body_too_large");
      error.statusCode = 413;
      error.code = "request_body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(payload));
}

function enqueueWebhookJob(payload) {
  webhookQueueDepth += 1;
  setGauge("webhook.queue_depth", webhookQueueDepth);
  webhookQueue = webhookQueue
    .then(() => processWebhookPayload(payload))
    .catch((error) => recordError("webhook_queue", error))
    .finally(() => {
      webhookQueueDepth -= 1;
      setGauge("webhook.queue_depth", webhookQueueDepth);
    });
}

function allowRequest(request, response, scope, limit) {
  const result = checkRateLimit(`${scope}:${getClientIp(request)}`, { limit, windowMs: 60_000 });
  if (result.allowed) return true;

  response.writeHead(429, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)))
  }));
  response.end(JSON.stringify({ error: "rate_limited" }));
  incrementMetric(`${scope}.rate_limited`);
  return false;
}

function requireAdminAccess(request, response) {
  const hasAdminToken = Boolean(getAdminToken());
  if (!hasAdminToken && isLocalHost(request.headers.host)) {
    return true;
  }

  const result = verifyAdminAuth(request.headers);
  if (result.ok) return true;

  if (result.reason === "admin_token_missing") {
    sendJson(response, 403, {
      error: "admin_auth_not_configured",
      message: "Set ADMIN_TOKEN before exposing the admin console outside localhost."
    });
    return false;
  }

  response.writeHead(401, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Meta Bot Console"'
  }));
  response.end(JSON.stringify({ error: "admin_auth_required" }));
  return false;
}

function securityHeaders(headers = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...headers
  };
}

function redactPayload(value) {
  if (typeof value === "string") return redactValue(value, true);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPayload(item)]));
  }
  return value;
}
