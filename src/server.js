import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";
import {
  DEFAULT_TENANT_ID,
  createTenant,
  approveTenantSignup,
  loadConfig,
  loadTenantConfig,
  loadTenants,
  normalizeTenantId,
  rejectTenantSignup,
  requireTenantPortalToken,
  resetTenantPortalPassword,
  saveConfig,
  saveTenantConfig,
  submitTenantSignup,
  verifyTenantPortalAccess
} from "./config-store.js";
import { routeIncomingMessage, appendConversationMessages } from "./bot-engine.js";
import { getMetrics, incrementMetric, recordError, setGauge } from "./metrics.js";
import { checkRateLimit, getClientIp } from "./rate-limit.js";
import { evaluateReadiness } from "./readiness.js";
import {
  adminSessionValue,
  getAdminToken,
  getAdminUsername,
  getAppSecret,
  getVerifyToken,
  isLocalHost,
  redactValue,
  shouldRequireSignature,
  verifyAdminAuth,
  verifyMetaSignature
} from "./security.js";
import { findChannel, normalizeMetaPayload, sendMetaText, fetchMetaUserProfile } from "./meta-client.js";
import { crawlTenantSite, catalogToKnowledgeDocuments } from "./site-crawler.js";
import { appendOrderRecord, appendUsageRecord, loadTenantStore, summarizeUsage, upsertCatalogSnapshot } from "./tenant-data.js";
import { appendRecordToSheet } from "./sheets-client.js";
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

export async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && isWebhookPath(url.pathname)) {
      return await handleWebhookVerify(url, response);
    }

    if (request.method === "POST" && isWebhookPath(url.pathname)) {
      if (!allowRequest(request, response, "webhook", Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE || 1000))) return;
      return await handleWebhookPost(request, response);
    }

    if (url.pathname.startsWith("/client-api/")) {
      return await handleClientApi(request, response, url);
    }

    if (url.pathname.startsWith("/auth/")) {
      return await handleAuthApi(request, response, url);
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health" && !allowRequest(request, response, "admin", Number(process.env.ADMIN_RATE_LIMIT_PER_MINUTE || 300))) return;
      if (url.pathname !== "/api/health" && !requireAdminAccess(request, response)) return;
      return await handleApi(request, response, url);
    }

    if (!isPublicAsset(url.pathname) && !requireAdminAccess(request, response)) return;
    return await serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, {
      error: error.code || "internal_server_error",
      message: error.message
    });
  }
}

if (!process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Meta bot console: http://localhost:${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  });
}

async function handleWebhookVerify(url, response) {
  const config = await loadTenantConfig(tenantIdFromWebhookPath(url.pathname));
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
  const tenantId = tenantIdFromWebhookPath(new URL(request.url, `http://${request.headers.host}`).pathname);
  const config = await loadTenantConfig(tenantId);
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
  enqueueWebhookJob(payload, tenantId);
}

async function processWebhookPayload(payload, tenantId = DEFAULT_TENANT_ID) {
  try {
    const config = await loadTenantConfig(tenantId);
    await pruneRawEvents(config.privacy.retentionDays);

    if (config.privacy.storeRawEvents) {
      await appendRawEvent({
        receivedAt: new Date().toISOString(),
        tenantId,
        object: payload.object,
        payload: config.privacy.redactLogs ? redactPayload(payload) : payload
      });
    }

    const incomingEvents = normalizeMetaPayload(payload);
    if (!incomingEvents.length) return;

    incrementMetric("webhook.events", incomingEvents.length);
    let conversations = pruneExpiredConversations(await loadConversations(tenantId), config.privacy.retentionDays);

    for (const incoming of incomingEvents) {
      const channel = findChannel(config, incoming);
      if (!channel) {
        incrementMetric("webhook.channel_miss");
        continue;
      }

      const isNewEvent = await markEventIfNew(
        incoming.id,
        config.automation.deduplicationWindowHours,
        tenantId
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
        attachments: incoming.attachments || [],
        config,
        conversation,
        channelType: channel.type,
        eventTimestamp: incoming.timestamp
      });
      appendConversationMessages(conversation, incoming.text, result, config, incoming.attachments || []);
      await recordCommerceOutcome({ tenantId, config, conversation, incoming, result });
      await recordUsageOutcome({ tenantId, config, incoming, result });
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

    await saveConversations(conversations, tenantId);
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
    return sendJson(response, 200, evaluateReadiness(await loadTenantConfig(url.searchParams.get("tenantId") || DEFAULT_TENANT_ID)));
  }

  if (request.method === "GET" && url.pathname === "/api/metrics") {
    return sendJson(response, 200, getMetrics());
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, await buildDashboardSummary());
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendJson(response, 200, await loadTenantConfig(url.searchParams.get("tenantId") || DEFAULT_TENANT_ID));
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const saved = await saveTenantConfig(url.searchParams.get("tenantId") || DEFAULT_TENANT_ID, body);
    return sendJson(response, 200, saved);
  }

  if (request.method === "GET" && url.pathname === "/api/tenants") {
    const tenants = await loadTenants();
    const conversationsByTenant = await Promise.all(
      tenants.map(async (tenant) => ({
        tenantId: tenant.id,
        conversations: pruneExpiredConversations(await loadConversations(tenant.id), (await loadTenantConfig(tenant.id)).privacy.retentionDays)
      }))
    );
    const stats = new Map(
      conversationsByTenant.map((item) => [
        item.tenantId,
        {
          conversations: item.conversations.length,
          handoffs: item.conversations.filter((conversation) => conversation.status === "handoff").length,
          lastActivityAt: item.conversations
            .map((conversation) => conversation.lastUserAt || conversation.lastBotAt || conversation.openedAt)
            .filter(Boolean)
            .sort()
            .at(-1) || null
        }
      ])
    );

    return sendJson(response, 200, tenants.map((tenant) => ({ ...publicTenant(tenant), stats: stats.get(tenant.id) || {} })));
  }

  if (request.method === "POST" && url.pathname === "/api/tenants") {
    const body = await readJsonBody(request);
    const tenant = await createTenant(body);
    const access = await resetTenantPortalPassword(tenant.id);
    return sendJson(response, 201, { ...publicTenant(tenant), portalPassword: access.password });
  }

  const approvalRoute = url.pathname.match(/^\/api\/tenants\/([^/]+)\/(approve|reject)$/);
  if (approvalRoute && request.method === "POST") {
    const tenantId = normalizeTenantId(approvalRoute[1]);
    if (approvalRoute[2] === "approve") {
      return sendJson(response, 200, await approveTenantSignup(tenantId));
    }
    return sendJson(response, 200, publicTenant(await rejectTenantSignup(tenantId)));
  }

  const tenantRoute = matchTenantApiRoute(url.pathname);
  if (tenantRoute) {
    return await handleTenantApi(request, response, url, tenantRoute);
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    const tenantId = url.searchParams.get("tenantId") || DEFAULT_TENANT_ID;
    const config = await loadTenantConfig(tenantId);
    const conversations = pruneExpiredConversations(await loadConversations(tenantId), config.privacy.retentionDays);
    await pruneRawEvents(config.privacy.retentionDays);
    await saveConversations(conversations, tenantId);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && url.pathname === "/api/test-message") {
    const body = await readJsonBody(request);
    const tenantId = body.tenantId || url.searchParams.get("tenantId") || DEFAULT_TENANT_ID;
    const config = await loadTenantConfig(tenantId);
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
      attachments: body.attachments || [],
      config,
      conversation,
      channelType: body.channelType || "messenger",
      eventTimestamp: body.eventTimestamp || Date.now()
    });
    return sendJson(response, 200, { result, conversation });
  }

  if (request.method === "POST" && url.pathname === "/api/privacy/delete-customer") {
    const body = await readJsonBody(request);
    const tenantId = body.tenantId || url.searchParams.get("tenantId") || DEFAULT_TENANT_ID;
    const current = await loadConversations(tenantId);
    const { conversations, deleted } = deleteCustomerData(current, body.platformUserId);
    const rawEventsDeleted = await deleteCustomerRawEvents(body.platformUserId);
    await saveConversations(conversations, tenantId);
    return sendJson(response, 200, { deleted, rawEventsDeleted });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleClientApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/client-api/signup") {
    const body = await readJsonBody(request);
    const signup = await submitTenantSignup(body);
    return sendJson(response, 201, {
      tenant: publicTenant(signup),
      status: "pending"
    });
  }

  if (request.method === "POST" && url.pathname === "/client-api/login") {
    const body = await readJsonBody(request);
    const tenant = await verifyTenantPortalAccess(body.tenantId, body.password);
    if (!tenant) return sendJson(response, 401, { error: "invalid_client_login" });
    return sendJson(response, 200, {
      tenant: publicTenant(tenant),
      token: body.password
    });
  }

  let tenant;
  try {
    tenant = await requireTenantPortalToken(request.headers);
  } catch (error) {
    return sendJson(response, error.statusCode || 401, { error: error.code || "client_auth_required" });
  }

  if (request.method === "GET" && url.pathname === "/client-api/me") {
    return sendJson(response, 200, { tenant: publicTenant(tenant) });
  }

  if (request.method === "GET" && url.pathname === "/client-api/config") {
    return sendJson(response, 200, await loadTenantConfig(tenant.id));
  }

  if (request.method === "GET" && url.pathname === "/client-api/store") {
    const config = await loadTenantConfig(tenant.id);
    const store = await loadTenantStore(tenant.id);
    return sendJson(response, 200, {
      ...store,
      usageSummary: summarizeUsage(store, config.usage?.monthlyLimitUsd || 0)
    });
  }

  if (request.method === "POST" && url.pathname === "/client-api/sync-site") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await syncTenantSite(tenant.id, body.sourceUrl));
  }

  if (request.method === "PUT" && url.pathname === "/client-api/config") {
    const body = await readJsonBody(request);
    const current = await loadTenantConfig(tenant.id);
    const saved = await saveTenantConfig(tenant.id, mergeClientEditableConfig(current, body));
    return sendJson(response, 200, saved);
  }

  if (request.method === "GET" && url.pathname === "/client-api/conversations") {
    const config = await loadTenantConfig(tenant.id);
    const conversations = pruneExpiredConversations(await loadConversations(tenant.id), config.privacy.retentionDays);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && url.pathname === "/client-api/test-message") {
    const config = await loadTenantConfig(tenant.id);
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
      attachments: body.attachments || [],
      config,
      conversation,
      channelType: body.channelType || "messenger",
      eventTimestamp: body.eventTimestamp || Date.now()
    });
    return sendJson(response, 200, { result, conversation });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleAuthApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/auth/admin-login") {
    const body = await readJsonBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (username === getAdminUsername() && password === getAdminToken() && getAdminToken()) {
      response.writeHead(200, securityHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `nibachat_admin=${encodeURIComponent(adminSessionValue(password))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 12}${process.env.VERCEL ? "; Secure" : ""}`
      }));
      response.end(JSON.stringify({ ok: true, redirectTo: "/admin.html" }));
      return;
    }

    return sendJson(response, 401, { error: "invalid_admin_login" });
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    response.writeHead(200, securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "nibachat_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    }));
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleTenantApi(request, response, url, route) {
  const tenantId = route.tenantId;

  if (request.method === "GET" && route.resource === "config") {
    return sendJson(response, 200, await loadTenantConfig(tenantId));
  }

  if (request.method === "GET" && route.resource === "store") {
    const config = await loadTenantConfig(tenantId);
    const store = await loadTenantStore(tenantId);
    return sendJson(response, 200, {
      ...store,
      usageSummary: summarizeUsage(store, config.usage?.monthlyLimitUsd || 0)
    });
  }

  if (request.method === "POST" && route.resource === "sync-site") {
    const body = await readJsonBody(request);
    const synced = await syncTenantSite(tenantId, body.sourceUrl);
    return sendJson(response, 200, synced);
  }

  if (request.method === "POST" && route.resource === "access") {
    return sendJson(response, 200, await resetTenantPortalPassword(tenantId));
  }

  if (request.method === "PUT" && route.resource === "config") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await saveTenantConfig(tenantId, body));
  }

  if (request.method === "GET" && route.resource === "conversations") {
    const config = await loadTenantConfig(tenantId);
    const conversations = pruneExpiredConversations(await loadConversations(tenantId), config.privacy.retentionDays);
    await saveConversations(conversations, tenantId);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && route.resource === "test-message") {
    const config = await loadTenantConfig(tenantId);
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
      attachments: body.attachments || [],
      config,
      conversation,
      channelType: body.channelType || "messenger",
      eventTimestamp: body.eventTimestamp || Date.now()
    });
    return sendJson(response, 200, { result, conversation });
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

async function syncTenantSite(tenantId, sourceUrl = "") {
  const config = await loadTenantConfig(tenantId);
  const effectiveUrl = sourceUrl || config.catalog?.sourceUrl;
  const snapshot = await crawlTenantSite(effectiveUrl, { maxPages: config.catalog?.maxPages || 8 });
  await upsertCatalogSnapshot(tenantId, snapshot);

  const documents = catalogToKnowledgeDocuments(snapshot);
  const saved = await saveTenantConfig(tenantId, {
    ...config,
    catalog: {
      ...(config.catalog || {}),
      sourceUrl: snapshot.sourceUrl,
      lastRefreshAt: new Date().toISOString(),
      products: snapshot.products,
      policies: snapshot.policies
    },
    knowledge: {
      ...(config.knowledge || {}),
      enabled: true,
      documents: mergeKnowledgeDocuments(config.knowledge?.documents || [], documents)
    }
  });

  return {
    sourceUrl: snapshot.sourceUrl,
    pages: snapshot.pages.length,
    products: snapshot.products.length,
    policies: snapshot.policies.length,
    config: saved
  };
}

async function recordCommerceOutcome({ tenantId, config, conversation, incoming, result }) {
  const commerce = result.commerce;
  if (!commerce?.shouldRecord) return null;

  const typeMap = {
    order: "order",
    complaint: "complaint",
    exchange: "exchange",
    late_shipment: "shipment_check"
  };
  const record = await appendOrderRecord(tenantId, {
    type: typeMap[commerce.intent] || commerce.intent,
    status: commerce.intent === "order" ? "ready_for_review" : "needs_followup",
    platformUserId: incoming.senderId,
    conversationId: conversation.id,
    customer: commerce.extracted?.customer || {},
    product: commerce.extracted?.product || {},
    delivery: commerce.extracted?.delivery || {},
    complaint: {
      intent: commerce.intent,
      description: incoming.text
    },
    notes: incoming.text,
    missingFields: commerce.missingFields || []
  });

  try {
    await appendRecordToSheet({ config, tenantId, record });
  } catch (error) {
    conversation.audit.push({
      actor: "sheets",
      action: "append.failed",
      payload: { message: error.message },
      createdAt: new Date().toISOString()
    });
  }

  return record;
}

async function recordUsageOutcome({ tenantId, config, incoming, result }) {
  if (!result.aiResponseId && !result.modelRouting) return null;
  const model = result.matched || result.modelRouting?.model || config.ai?.model || "";
  return appendUsageRecord(tenantId, {
    provider: config.ai?.provider || "openai",
    model,
    action: result.reason || result.action,
    inputChars: String(incoming.text || "").length,
    outputChars: String(result.reply || "").length,
    estimatedCost: estimateModelCost(model, incoming.text, result.reply)
  });
}

function estimateModelCost(model, input = "", output = "") {
  const tokens = Math.ceil((String(input).length + String(output).length) / 4);
  const normalized = String(model || "");
  const perMillion =
    normalized.includes("nano") ? 0.2 :
    normalized.includes("mini") ? 0.8 :
    normalized.includes("5.5") ? 3 :
    1;
  return Number(((tokens / 1_000_000) * perMillion).toFixed(6));
}

async function buildDashboardSummary() {
  const tenants = await loadTenants();
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const rows = await Promise.all(
    tenants.map(async (tenant) => {
      const config = await loadTenantConfig(tenant.id);
      const conversations = pruneExpiredConversations(await loadConversations(tenant.id), config.privacy.retentionDays);
      const store = await loadTenantStore(tenant.id);
      const usageSummary = summarizeUsage(store, config.usage?.monthlyLimitUsd || 0);
      const messagesToday = conversations.reduce((sum, conversation) => {
        return sum + (conversation.messages || []).filter((message) => {
          const createdAt = message.createdAt || message.timestamp || message.at || "";
          return String(createdAt).startsWith(todayPrefix);
        }).length;
      }, 0);
      const botRepliesToday = conversations.reduce((sum, conversation) => {
        return sum + (conversation.messages || []).filter((message) => {
          const createdAt = message.createdAt || message.timestamp || message.at || "";
          const actor = message.actor || message.role || message.from || message.sender || "";
          return String(createdAt).startsWith(todayPrefix) && /bot|assistant|ai/i.test(String(actor));
        }).length;
      }, 0);
      const lastActivityAt = conversations
        .flatMap((conversation) => [
          conversation.lastUserAt,
          conversation.lastBotAt,
          conversation.updatedAt,
          conversation.openedAt
        ])
        .filter(Boolean)
        .sort()
        .at(-1) || null;

      return {
        ...publicTenant(tenant),
        stats: {
          conversations: conversations.length,
          handoffs: conversations.filter((conversation) => conversation.status === "handoff").length,
          activeChannels: (config.channels || []).filter((channel) => channel.enabled).length,
          products: store.catalog?.products?.length || config.catalog?.products?.length || 0,
          orders: store.orders.filter((order) => order.type === "order").length,
          complaints: store.orders.filter((order) => order.type && order.type !== "order").length,
          messagesToday,
          botRepliesToday,
          lastActivityAt
        },
        usage: usageSummary,
        business: {
          name: config.business?.name || tenant.name,
          sourceUrl: config.catalog?.sourceUrl || store.catalog?.sourceUrl || "",
          provider: config.ai?.provider || "openai",
          model: config.ai?.model || "",
          apiKeyEnv: config.ai?.apiKeyEnv || "",
          sheetUrl: config.integrations?.googleSheets?.sheetUrl || "",
          sheetsEnabled: Boolean(config.integrations?.googleSheets?.enabled)
        }
      };
    })
  );

  const totals = rows.reduce((acc, tenant) => {
    acc.clients += 1;
    acc.conversations += tenant.stats.conversations;
    acc.messagesToday += tenant.stats.messagesToday;
    acc.botRepliesToday += tenant.stats.botRepliesToday;
    acc.handoffs += tenant.stats.handoffs;
    acc.orders += tenant.stats.orders;
    acc.complaints += tenant.stats.complaints;
    acc.estimatedCost += tenant.usage.estimatedCost || 0;
    acc.monthlyLimitUsd += tenant.usage.monthlyLimitUsd || 0;
    return acc;
  }, {
    clients: 0,
    conversations: 0,
    messagesToday: 0,
    botRepliesToday: 0,
    handoffs: 0,
    orders: 0,
    complaints: 0,
    estimatedCost: 0,
    monthlyLimitUsd: 0
  });

  totals.percentUsed = totals.monthlyLimitUsd > 0
    ? Math.min(100, Math.round((totals.estimatedCost / totals.monthlyLimitUsd) * 100))
    : 0;
  totals.percentRemaining = Math.max(0, 100 - totals.percentUsed);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    tenants: rows.sort((a, b) => String(b.stats.lastActivityAt || "").localeCompare(String(a.stats.lastActivityAt || "")))
  };
}

function mergeKnowledgeDocuments(existing, incoming) {
  const byId = new Map();
  for (const document of existing) byId.set(document.id, document);
  for (const document of incoming) byId.set(document.id, document);
  return Array.from(byId.values());
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

function enqueueWebhookJob(payload, tenantId = DEFAULT_TENANT_ID) {
  webhookQueueDepth += 1;
  setGauge("webhook.queue_depth", webhookQueueDepth);
  webhookQueue = webhookQueue
    .then(() => processWebhookPayload(payload, tenantId))
    .catch((error) => recordError("webhook_queue", error))
    .finally(() => {
      webhookQueueDepth -= 1;
      setGauge("webhook.queue_depth", webhookQueueDepth);
    });
}

function isWebhookPath(pathname) {
  return pathname === "/webhook" || /^\/webhook\/[a-z0-9_-]+$/i.test(pathname);
}

function tenantIdFromWebhookPath(pathname) {
  const match = pathname.match(/^\/webhook\/([a-z0-9_-]+)$/i);
  return match ? normalizeTenantId(match[1]) : DEFAULT_TENANT_ID;
}

function matchTenantApiRoute(pathname) {
  const match = pathname.match(/^\/api\/tenants\/([^/]+)\/(config|conversations|test-message|access|store|sync-site)$/);
  if (!match) return null;
  return {
    tenantId: normalizeTenantId(match[1]),
    resource: match[2]
  };
}

function isPublicAsset(pathname) {
  return pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/login.html" ||
    pathname === "/login.js" ||
    pathname === "/landing.js" ||
    pathname === "/client.html" ||
    pathname === "/client-app.js" ||
    pathname === "/styles.css" ||
    pathname.startsWith("/assets/");
}

function publicTenant(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    ownerEmail: tenant.ownerEmail,
    status: tenant.status,
    plan: tenant.plan,
    color: tenant.color || "#10b981",
    niche: tenant.niche || "",
    signupNote: tenant.signupNote || "",
    portalEnabled: tenant.portalEnabled !== false,
    requestedAt: tenant.requestedAt,
    approvedAt: tenant.approvedAt,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt
  };
}

function mergeClientEditableConfig(current, incoming) {
  return {
    ...current,
    business: {
      ...current.business,
      name: incoming.business?.name ?? current.business.name,
      language: incoming.business?.language ?? current.business.language,
      timezone: incoming.business?.timezone ?? current.business.timezone,
      shortDescription: incoming.business?.shortDescription ?? current.business.shortDescription,
      defaultReply: incoming.business?.defaultReply ?? current.business.defaultReply,
      privacyNoticeUrl: incoming.business?.privacyNoticeUrl ?? current.business.privacyNoticeUrl,
      dataDeletionUrl: incoming.business?.dataDeletionUrl ?? current.business.dataDeletionUrl
    },
    channels: current.channels,
    automation: {
      ...current.automation,
      enabled: incoming.automation?.enabled ?? current.automation.enabled,
      confidenceThreshold: incoming.automation?.confidenceThreshold ?? current.automation.confidenceThreshold,
      leadCapturePrompt: incoming.automation?.leadCapturePrompt ?? current.automation.leadCapturePrompt,
      handoffKeywords: incoming.automation?.handoffKeywords || current.automation.handoffKeywords,
      riskyKeywords: incoming.automation?.riskyKeywords || current.automation.riskyKeywords,
      collectFields: incoming.automation?.collectFields || current.automation.collectFields,
      rules: incoming.automation?.rules || current.automation.rules,
      faqs: incoming.automation?.faqs || current.automation.faqs
    },
    knowledge: incoming.knowledge || current.knowledge,
    catalog: {
      ...current.catalog,
      sourceUrl: incoming.catalog?.sourceUrl ?? current.catalog?.sourceUrl ?? "",
      autoRefreshEnabled: incoming.catalog?.autoRefreshEnabled ?? current.catalog?.autoRefreshEnabled ?? true,
      refreshEveryHours: incoming.catalog?.refreshEveryHours ?? current.catalog?.refreshEveryHours ?? 24,
      maxPages: incoming.catalog?.maxPages ?? current.catalog?.maxPages ?? 8
    },
    orders: current.orders,
    usage: current.usage,
    integrations: {
      ...current.integrations,
      googleSheets: incoming.integrations?.googleSheets || current.integrations?.googleSheets
    },
    ai: current.ai,
    handoff: current.handoff,
    privacy: {
      ...current.privacy,
      retentionDays: incoming.privacy?.retentionDays ?? current.privacy.retentionDays,
      redactLogs: incoming.privacy?.redactLogs ?? current.privacy.redactLogs
    }
  };
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
  const adminToken = getAdminToken();
  const hasRealAdminToken = Boolean(adminToken) && !isPlaceholderAdminToken(adminToken);
  if (!hasRealAdminToken && isLocalHost(request.headers.host)) {
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
    "WWW-Authenticate": 'Basic realm="NibaChat Console"'
  }));
  response.end(JSON.stringify({ error: "admin_auth_required" }));
  return false;
}

function isPlaceholderAdminToken(value) {
  return String(value || "").trim() === "change-this-admin-token";
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
