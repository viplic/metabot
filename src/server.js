import http from "node:http";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";
import {
  DEFAULT_TENANT_ID,
  createTenant,
  deleteTenant,
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
  safeStringEqual,
  shouldRequireSignature,
  verifyAdminAuth,
  verifyMetaSignature
} from "./security.js";
import { findChannel, normalizeMetaPayload, sendMetaText, fetchMetaUserProfile, getPageAccessToken } from "./meta-client.js";
import { crawlTenantSite, catalogToKnowledgeDocuments } from "./site-crawler.js";
import {
  appendLearningMemory,
  appendOrderRecord,
  appendUsageRecord,
  hasSimilarLearningMemory,
  loadTenantStore,
  summarizeUsage,
  updateLearningMemory,
  upsertCatalogSnapshot
} from "./tenant-data.js";
import { appendRecordToSheet } from "./sheets-client.js";
import { fetchWithTimeout } from "./http.js";
import {
  encryptSecret,
  hasStoredSecret,
  looksLikeEnvName,
  shouldPreserveSecretInput
} from "./secrets.js";
import {
  appendRawEvent,
  deleteCustomerRawEvents,
  deleteCustomerData,
  findOrCreateConversation,
  loadConversations,
  loadRawEvents,
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

    if (url.pathname === "/client-api/login" || url.pathname === "/client-api/signup") {
      if (!allowRequest(request, response, "client_auth", Number(process.env.CLIENT_AUTH_RATE_LIMIT_PER_MINUTE || 30))) return;
    }

    if (url.pathname.startsWith("/client-api/")) {
      return await handleClientApi(request, response, url);
    }

    if (url.pathname === "/auth/admin-login") {
      if (!allowRequest(request, response, "admin_login", Number(process.env.ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE || 20))) return;
    }

    if (url.pathname.startsWith("/auth/")) {
      return await handleAuthApi(request, response, url);
    }

    if (url.pathname === "/meta-oauth/callback") {
      return await handleMetaOAuthCallback(request, response, url);
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

  const processing = enqueueWebhookJob(payload, tenantId);
  if (process.env.WEBHOOK_ASYNC === "true") {
    sendJson(response, 200, { ok: true, mode: "queued" });
    return;
  }

  await processing;
  sendJson(response, 200, { ok: true, mode: "processed" });
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
      await maybeCreateLearningSuggestion({ tenantId, config, conversation, incoming, result });
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
    return sendJson(response, 200, publicConfig(await loadTenantConfig(url.searchParams.get("tenantId") || DEFAULT_TENANT_ID)));
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const tenantId = url.searchParams.get("tenantId") || DEFAULT_TENANT_ID;
    const current = await loadTenantConfig(tenantId);
    const saved = await saveTenantConfig(tenantId, prepareSecretsForSave(body, current));
    return sendJson(response, 200, publicConfig(saved));
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
    return sendJson(response, 200, { deleted: publicTenant(await rejectTenantSignup(tenantId)) });
  }

  const deleteRoute = url.pathname.match(/^\/api\/tenants\/([^/]+)$/);
  if (deleteRoute && request.method === "DELETE") {
    const tenantId = normalizeTenantId(deleteRoute[1]);
    return sendJson(response, 200, { deleted: publicTenant(await deleteTenant(tenantId)) });
  }

  const learningRoute = url.pathname.match(/^\/api\/tenants\/([^/]+)\/learning(?:\/([^/]+)\/(approve|reject))?$/);
  if (learningRoute) {
    return handleLearningApi(request, response, url, {
      tenantId: normalizeTenantId(learningRoute[1]),
      memoryId: learningRoute[2] || "",
      action: learningRoute[3] || ""
    });
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
    const config = testMessageConfig(await loadTenantConfig(tenantId), body);
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
    return sendJson(response, 200, { result, conversation, aiFallbackEnabled: Boolean(config.ai?.enabled) });
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
    return sendJson(response, 200, publicConfig(await loadTenantConfig(tenant.id)));
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
    return sendJson(response, 200, publicConfig(saved));
  }

  if (request.method === "GET" && url.pathname === "/client-api/conversations") {
    const config = await loadTenantConfig(tenant.id);
    const conversations = pruneExpiredConversations(await loadConversations(tenant.id), config.privacy.retentionDays);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && url.pathname === "/client-api/test-message") {
    const body = await readJsonBody(request);
    const config = testMessageConfig(await loadTenantConfig(tenant.id));
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
    return sendJson(response, 200, { result, conversation, aiFallbackEnabled: false });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleAuthApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/auth/admin-login") {
    const body = await readJsonBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    const adminToken = getAdminToken();
    if (username === getAdminUsername() && adminToken && safeStringEqual(password, adminToken)) {
      response.writeHead(200, securityHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `nibachat_admin=${encodeURIComponent(adminSessionValue(adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 12}${process.env.VERCEL ? "; Secure" : ""}`
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
    return sendJson(response, 200, publicConfig(await loadTenantConfig(tenantId)));
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

  if (request.method === "GET" && route.resource === "meta-health") {
    return sendJson(response, 200, await checkTenantMetaHealth(tenantId));
  }

  if (request.method === "GET" && route.resource === "raw-events") {
    const limit = Number(url.searchParams.get("limit") || 50);
    return sendJson(response, 200, await loadRawEvents(tenantId, limit));
  }

  if (request.method === "GET" && route.resource === "meta-oauth-start") {
    return sendJson(response, 200, await startTenantMetaOAuth(tenantId, request));
  }

  if (request.method === "POST" && route.resource === "meta-connect") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, await connectTenantMetaPage(tenantId, body));
  }

  if (request.method === "POST" && route.resource === "access") {
    return sendJson(response, 200, await resetTenantPortalPassword(tenantId));
  }

  if (request.method === "PUT" && route.resource === "config") {
    const body = await readJsonBody(request);
    const current = await loadTenantConfig(tenantId);
    const saved = await saveTenantConfig(tenantId, prepareSecretsForSave(body, current));
    return sendJson(response, 200, publicConfig(saved));
  }

  if (request.method === "GET" && route.resource === "conversations") {
    const config = await loadTenantConfig(tenantId);
    const conversations = pruneExpiredConversations(await loadConversations(tenantId), config.privacy.retentionDays);
    await saveConversations(conversations, tenantId);
    return sendJson(response, 200, conversations);
  }

  if (request.method === "POST" && route.resource === "test-message") {
    const body = await readJsonBody(request);
    const config = testMessageConfig(await loadTenantConfig(tenantId), body);
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
    return sendJson(response, 200, { result, conversation, aiFallbackEnabled: Boolean(config.ai?.enabled) });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleLearningApi(request, response, url, route) {
  const tenantId = route.tenantId;

  if (request.method === "GET" && !route.memoryId) {
    const store = await loadTenantStore(tenantId);
    return sendJson(response, 200, store.memories || []);
  }

  if (request.method === "POST" && !route.memoryId && url.searchParams.get("action") === "generate") {
    try {
      return sendJson(response, 200, await generateLearningSuggestionsFromConversations(tenantId));
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.code || "learning_generation_failed", message: error.message });
    }
  }

  if (request.method === "POST" && route.memoryId && route.action === "approve") {
    const body = await readJsonBody(request);
    const store = await loadTenantStore(tenantId);
    const memory = store.memories.find((item) => item.id === route.memoryId);
    if (!memory) return sendJson(response, 404, { error: "learning_memory_not_found" });

    const question = String(body.question ?? memory.question ?? "").trim();
    const answer = String(body.suggestedAnswer ?? memory.suggestedAnswer ?? "").trim();
    if (!question || !answer) return sendJson(response, 400, { error: "question_and_answer_required" });

    const config = await loadTenantConfig(tenantId);
    const documentId = `learned-${route.memoryId}`;
    const saved = await saveTenantConfig(tenantId, {
      ...config,
      knowledge: {
        ...(config.knowledge || {}),
        documents: mergeKnowledgeDocuments(config.knowledge?.documents || [], [{
          id: documentId,
          enabled: true,
          title: question.slice(0, 120),
          keywords: extractLearningKeywords(question),
          content: `Pitanje kupca: ${question}\nProveren odgovor: ${answer}`,
          response: answer
        }])
      }
    });

    const updated = await updateLearningMemory(tenantId, route.memoryId, {
      status: "approved",
      question,
      suggestedAnswer: answer
    });
    return sendJson(response, 200, { memory: updated, config: publicConfig(saved) });
  }

  if (request.method === "POST" && route.memoryId && route.action === "reject") {
    const updated = await updateLearningMemory(tenantId, route.memoryId, { status: "rejected" });
    if (!updated) return sendJson(response, 404, { error: "learning_memory_not_found" });
    return sendJson(response, 200, { memory: updated });
  }

  sendJson(response, 404, { error: "not_found" });
}

async function checkTenantMetaHealth(tenantId) {
  const config = await loadTenantConfig(tenantId);
  const version = config.meta?.graphApiVersion || "v25.0";

  const channels = await Promise.all((config.channels || []).map(async (channel) => {
    const { accessToken, source } = getPageAccessToken(config, channel);
    const base = {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      enabled: Boolean(channel.enabled),
      sendEnabled: Boolean(channel.sendEnabled),
      tokenSource: source,
      tokenPresent: Boolean(accessToken),
      ok: false,
      status: "missing_token"
    };

    if (!accessToken) return base;

    try {
      const url = new URL(`https://graph.facebook.com/${version}/me`);
      url.searchParams.set("fields", "id,name");
      url.searchParams.set("access_token", accessToken);
      const response = await fetchWithTimeout(url, {}, 8000);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ...base,
          status: "invalid_token",
          errorCode: body?.error?.code || null,
          errorSubcode: body?.error?.error_subcode || null,
          message: body?.error?.message || `Meta returned ${response.status}`
        };
      }

      const subscription = channel.type === "messenger"
        ? await checkPageWebhookSubscription({ version, pageId: channel.pageId || body.id, pageAccessToken: accessToken })
        : null;

      return {
        ...base,
        ok: true,
        status: "ok",
        subscription,
        metaIdentity: {
          id: body.id || "",
          name: body.name || ""
        }
      };
    } catch (error) {
      return {
        ...base,
        status: "check_failed",
        message: error.message
      };
    }
  }));

  return {
    tenantId,
    ok: channels.filter((channel) => channel.enabled && channel.sendEnabled).every((channel) => channel.ok),
    checkedAt: new Date().toISOString(),
    channels
  };
}

async function checkPageWebhookSubscription({ version, pageId, pageAccessToken }) {
  if (!pageId || !pageAccessToken) return { ok: false, status: "missing_page_id" };
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps`);
  url.searchParams.set("access_token", pageAccessToken);
  try {
    const response = await fetchWithTimeout(url, {}, 8000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: "check_failed",
        message: body?.error?.message || `Meta returned ${response.status}`
      };
    }
    const data = Array.isArray(body.data) ? body.data : [];
    return {
      ok: data.length > 0,
      status: data.length > 0 ? "subscribed" : "not_subscribed",
      apps: data.map((app) => ({ id: app.id || "", name: app.name || "" })).filter((app) => app.id || app.name)
    };
  } catch (error) {
    return { ok: false, status: "check_failed", message: error.message };
  }
}

async function startTenantMetaOAuth(tenantId, request) {
  const config = await loadTenantConfig(tenantId);
  const appId = String(config.meta?.appId || "").trim();
  if (!appId) return badRequest("meta_app_id_required", "Unesi Meta App ID i sacuvaj pre povezivanja preko Facebook login-a.");
  const configId = String(config.meta?.businessLoginConfigId || "").trim();
  if (!configId) {
    return badRequest(
      "meta_business_config_required",
      "Unesi Business Login Configuration ID iz Meta Developers > Facebook Login for Business > Configurations, sacuvaj, pa pokreni povezivanje."
    );
  }

  const redirectUri = metaOAuthRedirectUri(request);
  const state = signMetaOAuthState({ tenantId, redirectUri, createdAt: Date.now() });
  const version = config.meta?.graphApiVersion || "v25.0";
  const authUrl = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  authUrl.searchParams.set("client_id", appId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("auth_type", "rerequest");
  authUrl.searchParams.set("config_id", configId);
  authUrl.searchParams.set("override_default_response_type", "true");

  return {
    authUrl: authUrl.toString(),
    redirectUri,
    configId: configId || "",
    scopes: authUrl.searchParams.get("scope")?.split(",") || []
  };
}

async function handleMetaOAuthCallback(request, response, url) {
  const code = url.searchParams.get("code") || "";
  const rawState = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error_message") || url.searchParams.get("error_description") || "";

  try {
    if (error) throw metaConnectError("meta_oauth_denied", error);
    if (!code || !rawState) throw metaConnectError("meta_oauth_missing_code", "Facebook nije vratio code/state za povezivanje.");

    const state = verifyMetaOAuthState(rawState);
    const config = await loadTenantConfig(state.tenantId);
    const appId = String(config.meta?.appId || "").trim();
    const appSecret = getAppSecret(config);
    if (!appId) throw metaConnectError("meta_app_id_required", "Meta App ID nije sacuvan za ovog klijenta.");
    if (!appSecret) throw metaConnectError("meta_app_secret_required", "App secret nije sacuvan za ovog klijenta.");

    const token = await exchangeMetaOAuthCode({
      version: config.meta?.graphApiVersion || "v25.0",
      appId,
      appSecret,
      code,
      redirectUri: state.redirectUri
    });
    const result = await connectTenantMetaPage(state.tenantId, {
      userAccessToken: token,
      appId,
      pageId: ""
    });

    return sendHtml(response, 200, metaOAuthResultHtml({
      ok: true,
      title: "Meta povezivanje je uspelo",
      message: `Povezana stranica: ${result.page?.name || result.page?.id || "Meta stranica"}. Mozes zatvoriti ovaj prozor i kliknuti Proveri Meta tokene.`,
      tenantId: state.tenantId
    }));
  } catch (callbackError) {
    return sendHtml(response, callbackError.statusCode || 500, metaOAuthResultHtml({
      ok: false,
      title: "Meta povezivanje nije uspelo",
      message: callbackError.message || "Pokusaj ponovo.",
      tenantId: ""
    }));
  }
}

async function exchangeMetaOAuthCode({ version, appId, appSecret, code, redirectUri }) {
  const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);
  const tokenResponse = await fetchWithTimeout(tokenUrl, {}, 10000);
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw metaConnectError("meta_oauth_code_exchange_failed", tokenBody?.error?.message || `Meta returned ${tokenResponse.status}`);
  }
  return tokenBody.access_token;
}

async function connectTenantMetaPage(tenantId, body = {}) {
  const config = await loadTenantConfig(tenantId);
  const version = config.meta?.graphApiVersion || "v25.0";
  const appId = String(config.meta?.appId || body.appId || "").trim();
  const appSecret = getAppSecret(config);
  const userAccessToken = cleanMetaAccessToken(body.userAccessToken);
  const configuredPageIds = new Set((config.channels || []).map((channel) => String(channel.pageId || "")).filter(Boolean));
  const preferredPageId = String(body.pageId || configuredPageIds.values().next().value || "").trim();

  if (!appId) return badRequest("meta_app_id_required", "Unesi Meta App ID u Meta API podesavanjima i sacuvaj.");
  if (!appSecret) return badRequest("meta_app_secret_required", "Unesi App secret u Meta API podesavanjima i sacuvaj.");
  if (!userAccessToken) return badRequest("meta_user_token_required", "Nalepi User Access Token za reconnect.");

  let pageLookupToken = userAccessToken;
  let exchangeWarning = "";
  try {
    pageLookupToken = await exchangeForLongLivedUserToken({ version, appId, appSecret, userAccessToken });
  } catch (error) {
    exchangeWarning = error.message;
  }

  let pages = [];
  const diagnostics = {
    tenantId,
    preferredPageId: preferredPageId || "",
    usedLongLivedExchange: pageLookupToken !== userAccessToken,
    meAccountsCount: 0,
    meFieldsCount: 0,
    directPageFound: false
  };
  try {
    pages = await fetchManagedPages({ version, accessToken: pageLookupToken });
    diagnostics.meAccountsCount = pages.length;
    if (!pages.length) {
      const fieldPages = await fetchManagedPagesViaMeFields({ version, accessToken: pageLookupToken });
      diagnostics.meFieldsCount = fieldPages.length;
      if (fieldPages.length) pages = fieldPages;
    }
    if (!pages.length && preferredPageId) {
      const directPage = await fetchManagedPageById({ version, accessToken: pageLookupToken, pageId: preferredPageId });
      diagnostics.directPageFound = Boolean(directPage);
      if (directPage) pages = [directPage];
    }
  } catch (error) {
    console.warn("Meta connect token lookup failed", {
      ...diagnostics,
      code: error.code || "",
      message: error.message || ""
    });
    const message = exchangeWarning
      ? `Meta nije prihvatila ovaj User Access Token. Napravi novi User token za istu aplikaciju i obavezno koristi copy ikonicu. Detalj: ${error.message || exchangeWarning}`
      : error.message;
    throw metaConnectError("meta_user_token_invalid", message);
  }
  if (!pages.length) {
    console.warn("Meta connect returned no pages", diagnostics);
    const pageHint = preferredPageId ? ` Proveri da je Page ID tacan (${preferredPageId}) i da je ta stranica izabrana u Facebook login dozvolama.` : "";
    return badRequest("no_managed_pages", `Meta nije vratila nijednu Facebook stranicu za ovaj token.${pageHint}`);
  }

  const selectedPage = pages.find((page) => preferredPageId && String(page.id) === preferredPageId) ||
    pages.find((page) => configuredPageIds.has(String(page.id))) ||
    pages[0];

  if (!selectedPage?.access_token) {
    return badRequest("page_token_not_returned", "Meta nije vratila Page access token za izabranu stranicu.");
  }

  const subscription = await subscribePageToWebhooks({
    version,
    pageId: selectedPage.id,
    pageAccessToken: selectedPage.access_token
  });
  const instagramId = selectedPage.instagram_business_account?.id || "";
  const updated = structuredClone(config);
  updated.meta ||= {};
  updated.meta.pageAccessTokenEncrypted = encryptSecret(selectedPage.access_token);
  updated.meta.pageAccessTokenEnv = updated.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
  updated.channels = (updated.channels || []).map((channel) => {
    const next = { ...channel };
    const isMessengerMatch = next.type === "messenger" && (!next.pageId || String(next.pageId) === String(selectedPage.id));
    const isInstagramMatch = next.type === "instagram" && (!next.igAccountId || (instagramId && String(next.igAccountId) === String(instagramId)));
    if (isMessengerMatch || isInstagramMatch) {
      next.pageId = next.pageId || String(selectedPage.id);
      if (next.type === "instagram" && instagramId) next.igAccountId = String(instagramId);
      next.pageAccessTokenEncrypted = encryptSecret(selectedPage.access_token);
      next.pageAccessTokenEnv = next.pageAccessTokenEnv || updated.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
      next.enabled = true;
      next.sendEnabled = true;
    }
    return next;
  });

  const saved = await saveTenantConfig(tenantId, updated);
  let learning = { skipped: true };
  if (saved.knowledge?.learning?.fromOldChatsEnabled) {
    try {
      learning = await generateLearningSuggestionsFromConversations(
        tenantId,
        saved.knowledge.learning.maxOldChats || 30
      );
    } catch (error) {
      learning = { skipped: true, error: error.message };
    }
  }

  return {
    ok: true,
    page: {
      id: selectedPage.id,
      name: selectedPage.name || ""
    },
    instagramBusinessAccount: instagramId ? { id: instagramId } : null,
    subscription,
    warning: [exchangeWarning, subscription.ok ? "" : subscription.message].filter(Boolean).join(" "),
    learning,
    config: publicConfig(saved)
  };
}

async function subscribePageToWebhooks({ version, pageId, pageAccessToken }) {
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps`);
  url.searchParams.set("access_token", pageAccessToken);
  url.searchParams.set("subscribed_fields", "messages,messaging_postbacks");

  try {
    const response = await fetchWithTimeout(url, { method: "POST" }, 10000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      return {
        ok: false,
        status: response.status,
        message: body?.error?.message || `Meta subscription returned ${response.status}`
      };
    }
    return { ok: true, fields: ["messages", "messaging_postbacks"] };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function exchangeForLongLivedUserToken({ version, appId, appSecret, userAccessToken }) {
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", userAccessToken);
  const response = await fetchWithTimeout(url, {}, 10000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw metaConnectError("long_lived_token_failed", body?.error?.message || `Meta returned ${response.status}`);
  }
  return body.access_token;
}

async function fetchManagedPages({ version, accessToken }) {
  const url = new URL(`https://graph.facebook.com/${version}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
  url.searchParams.set("access_token", accessToken);
  const response = await fetchWithTimeout(url, {}, 10000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw metaConnectError("managed_pages_failed", body?.error?.message || `Meta returned ${response.status}`);
  }
  return Array.isArray(body.data) ? body.data : [];
}

async function fetchManagedPagesViaMeFields({ version, accessToken }) {
  const url = new URL(`https://graph.facebook.com/${version}/me`);
  url.searchParams.set("fields", "accounts{id,name,access_token,instagram_business_account}");
  url.searchParams.set("access_token", accessToken);
  const response = await fetchWithTimeout(url, {}, 10000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return [];
  return Array.isArray(body.accounts?.data) ? body.accounts.data : [];
}

async function fetchManagedPageById({ version, accessToken, pageId }) {
  const cleanPageId = String(pageId || "").trim();
  if (!cleanPageId) return null;
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(cleanPageId)}`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
  url.searchParams.set("access_token", accessToken);
  const response = await fetchWithTimeout(url, {}, 10000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return body?.id ? body : null;
}

function cleanMetaAccessToken(value) {
  let token = String(value || "").trim();
  const queryMatch = token.match(/[?&#]access_token=([^&#\s]+)/i) || token.match(/^access_token=([^&#\s]+)/i);
  if (queryMatch) token = decodeURIComponent(queryMatch[1]);
  token = token
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "");
  const tokenMatch = token.match(/EAA[A-Za-z0-9_-]+/);
  return tokenMatch ? tokenMatch[0] : token;
}

function badRequest(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  throw error;
}

function metaConnectError(code, message) {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = code;
  return error;
}

function metaOAuthRedirectUri(request) {
  const publicAppUrl = normalizedPublicAppUrl();
  if (publicAppUrl) return `${publicAppUrl}/meta-oauth/callback`;

  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const proto = request.headers["x-forwarded-proto"] || (isLocalHost(host) ? "http" : "https");
  return `${proto}://${host}/meta-oauth/callback`;
}

function normalizedPublicAppUrl() {
  const configured =
    process.env.PUBLIC_APP_URL ||
    process.env.NIBACHAT_PUBLIC_URL ||
    process.env.SITE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "";
  const trimmed = String(configured).trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function signMetaOAuthState(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", metaOAuthStateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyMetaOAuthState(value) {
  const [encoded, signature] = String(value || "").split(".");
  if (!encoded || !signature) throw metaConnectError("meta_oauth_bad_state", "Facebook state nije validan.");
  const expected = crypto.createHmac("sha256", metaOAuthStateSecret()).update(encoded).digest("base64url");
  if (!safeStringEqual(signature, expected)) throw metaConnectError("meta_oauth_bad_state", "Facebook state potpis nije validan.");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.tenantId || !payload.redirectUri) throw metaConnectError("meta_oauth_bad_state", "Facebook state nema potrebne podatke.");
  if (Date.now() - Number(payload.createdAt || 0) > 15 * 60 * 1000) {
    throw metaConnectError("meta_oauth_expired_state", "Facebook povezivanje je isteklo. Pokreni ga ponovo.");
  }
  return {
    tenantId: normalizeTenantId(payload.tenantId),
    redirectUri: String(payload.redirectUri)
  };
}

function metaOAuthStateSecret() {
  return getAdminToken() || process.env.SECRET_KEY || "metabot-local-oauth-state";
}

function sendHtml(response, status, html) {
  response.writeHead(status, securityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
  response.end(html);
}

function metaOAuthResultHtml({ ok, title, message, tenantId }) {
  const color = ok ? "#10b981" : "#ef4444";
  const safeTitle = escapeHtmlText(title);
  const safeMessage = escapeHtmlText(message);
  const backUrl = tenantId ? `/admin.html?tenant=${encodeURIComponent(tenantId)}` : "/admin.html";
  return `<!doctype html>
<html lang="sr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07111f;color:#f8fafc;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:680px;margin:24px;padding:32px;border:1px solid rgba(148,163,184,.28);border-radius:16px;background:#0d1728;box-shadow:0 24px 80px rgba(0,0,0,.3)}
    .dot{width:56px;height:56px;border-radius:50%;background:${color};box-shadow:0 0 36px ${color}66}
    h1{font-size:28px;margin:20px 0 12px}
    p{color:#cbd5e1;font-size:17px;line-height:1.55}
    a{display:inline-block;margin-top:18px;color:#fff;text-decoration:none;background:#10b981;padding:12px 18px;border-radius:10px;font-weight:700}
  </style>
</head>
<body>
  <main>
    <div class="dot"></div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a href="${backUrl}">Vrati se u NibaChat</a>
  </main>
</body>
</html>`;
}

function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function maybeOpenTicket(config, conversation, incoming, result) {
  if (result.action !== "handoff") return;
  if (!config.handoff.ticketing.enabled) return;

  const webhookUrl = config.handoff.ticketing.webhookUrl ||
    process.env[config.handoff.ticketing.webhookUrlEnv || "TICKETING_WEBHOOK_URL"];
  if (!webhookUrl) return;

  try {
    const response = await fetchWithTimeout(webhookUrl, {
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
    }, Number(config.handoff.ticketing.timeoutMs || 8000));

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
    notes: commerceRecordNotes(incoming, commerce),
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

async function maybeCreateLearningSuggestion({ tenantId, config, conversation, incoming, result }) {
  const learning = config?.knowledge?.learning || {};
  if (learning.suggestFromNewChats === false && incoming.source !== "old_chat_scan") return null;
  const question = String(incoming.text || "").trim();
  if (!shouldSuggestLearning(question, result)) return null;
  if (await hasSimilarLearningMemory(tenantId, question)) return null;

  const suggestedAnswer = buildSuggestedLearningAnswer(result);
  const memory = await appendLearningMemory(tenantId, {
    status: learning.autoApprove ? "approved" : "review",
    question: question.slice(0, 800),
    suggestedAnswer,
    source: `conversation:${conversation.id}:${result.reason || result.action || "unknown"}`
  });

  if (learning.autoApprove && suggestedAnswer) {
    const documentId = `learned-${memory.id}`;
    await saveTenantConfig(tenantId, {
      ...config,
      knowledge: {
        ...(config.knowledge || {}),
        documents: mergeKnowledgeDocuments(config.knowledge?.documents || [], [{
          id: documentId,
          enabled: true,
          title: question.slice(0, 120),
          keywords: extractLearningKeywords(question),
          content: `Pitanje kupca: ${question}\nProveren odgovor: ${suggestedAnswer}`,
          response: suggestedAnswer
        }])
      }
    });
  }

  conversation.audit.push({
    actor: "learning",
    action: "suggestion.created",
    payload: { memoryId: memory.id, reason: result.reason || result.action },
    createdAt: new Date().toISOString()
  });

  return memory;
}

function shouldSuggestLearning(question, result) {
  if (!question || question.length < 8) return false;
  if (result.action === "handoff") return true;
  if (result.action === "fallback") return true;
  if (result.reason === "ai_error" || result.reason === "missing_ai_api_key") return true;
  if (result.action === "reply" && Number(result.confidence || 0) < 0.7) return true;
  return false;
}

function buildSuggestedLearningAnswer(result) {
  if (result.action === "reply" && result.reply) return result.reply.slice(0, 1200);
  if (result.reason === "ai_error") {
    return "Dodaj tacan odgovor koji automatizacija treba da koristi kada kupac postavi ovo pitanje.";
  }
  return "Upisi provereni odgovor pre odobravanja. Ne odobravaj ako odgovor nije siguran ili ako zavisi od trenutne dostupnosti/cene.";
}

function extractLearningKeywords(question) {
  const words = String(question || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 8);
  return [...new Set([question.slice(0, 80), ...words].filter(Boolean))];
}

async function generateLearningSuggestionsFromConversations(tenantId, limit = 30) {
  const config = await loadTenantConfig(tenantId);
  if (!config.knowledge?.learning?.fromOldChatsEnabled) {
    const error = new Error("Learning from old chats is disabled for this tenant.");
    error.statusCode = 403;
    error.code = "old_chat_learning_disabled";
    throw error;
  }
  const conversations = pruneExpiredConversations(await loadConversations(tenantId), config.privacy.retentionDays);
  let created = 0;
  const maxOldChats = Number(limit || config.knowledge.learning.maxOldChats || 30);

  for (const conversation of conversations.slice(0, maxOldChats)) {
    const messages = conversation.messages || [];
    const lastUser = [...messages].reverse().find((message) => (message.sender === "user" || message.role === "user") && message.body);
    if (!lastUser) continue;
    const lastBot = [...messages].reverse().find((message) =>
      (message.sender === "bot" || message.sender === "assistant" || message.role === "assistant") && message.body
    );
    const pseudoResult = {
      action: conversation.status === "handoff" ? "handoff" : "reply",
      reason: conversation.status || "conversation_review",
      confidence: conversation.status === "handoff" ? 0.2 : 0.62,
      reply: lastBot?.body || ""
    };
    const memory = await maybeCreateLearningSuggestion({
      tenantId,
      config,
      conversation,
      incoming: { text: lastUser.body, source: "old_chat_scan" },
      result: pseudoResult
    });
    if (memory) created += 1;
  }

  return { created };
}

function commerceRecordNotes(incoming, commerce) {
  const parts = [];
  const text = String(incoming.text || "").trim();
  if (text) parts.push(text);

  const attachments = incoming.attachments || [];
  if (attachments.length) {
    parts.push(`Kupac je poslao ${attachments.length} sliku/fajl.`);
  }

  const product = commerce.extracted?.product || {};
  if (product.name && product.matchSource) {
    parts.push(`Prepoznat proizvod: ${product.name}${product.price ? ` (${product.price})` : ""}. Izvor: ${product.matchSource}.`);
  }

  return parts.join(" ");
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
          apiConfigured: Boolean(
            config.ai?.apiKeyEncrypted ||
            config.ai?.apiKeySecret ||
            (config.ai?.apiKeyEnv && (!looksLikeEnvName(config.ai.apiKeyEnv) || process.env[config.ai.apiKeyEnv]))
          ),
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

export function testMessageConfig(config, body = {}) {
  if (body.allowAi === true || body.useAi === true) return config;
  return {
    ...config,
    ai: {
      ...(config.ai || {}),
      enabled: false
    }
  };
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
      "Cache-Control": cacheControlFor(pathname, ext)
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

function cacheControlFor(pathname, ext) {
  if (ext === ".html") return "no-store";
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (ext === ".css") return "public, max-age=300, must-revalidate";
  if (ext === ".js") return "no-store";
  return "no-store";
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
  return webhookQueue;
}

function isWebhookPath(pathname) {
  return pathname === "/webhook" || /^\/webhook\/[a-z0-9_-]+$/i.test(pathname);
}

function tenantIdFromWebhookPath(pathname) {
  const match = pathname.match(/^\/webhook\/([a-z0-9_-]+)$/i);
  return match ? normalizeTenantId(match[1]) : DEFAULT_TENANT_ID;
}

function matchTenantApiRoute(pathname) {
  const match = pathname.match(/^\/api\/tenants\/([^/]+)\/(config|conversations|test-message|access|store|sync-site|meta-health|raw-events|meta-connect|meta-oauth-start)$/);
  if (!match) return null;
  return {
    tenantId: normalizeTenantId(match[1]),
    resource: match[2]
  };
}

function prepareSecretsForSave(incoming, current = {}) {
  const prepared = structuredClone(incoming || {});
  prepared.meta ||= {};
  current.meta ||= {};

  const directAppSecret = prepared.meta.appSecretValue;
  if (shouldPreserveSecretInput(directAppSecret)) {
    prepared.meta.appSecretEncrypted = current.meta.appSecretEncrypted ||
      (current.meta.appSecretEnv && !looksLikeEnvName(current.meta.appSecretEnv) ? encryptSecret(current.meta.appSecretEnv) : "");
  } else {
    prepared.meta.appSecretEncrypted = encryptSecret(directAppSecret);
  }
  delete prepared.meta.appSecretValue;
  delete prepared.meta.hasAppSecret;

  if (prepared.meta.appSecretEnv && !looksLikeEnvName(prepared.meta.appSecretEnv)) {
    prepared.meta.appSecretEncrypted = encryptSecret(prepared.meta.appSecretEnv);
    prepared.meta.appSecretEnv = current.meta.appSecretEnv || "META_APP_SECRET";
  }

  const directPageToken = prepared.meta.pageAccessTokenValue;
  if (shouldPreserveSecretInput(directPageToken)) {
    prepared.meta.pageAccessTokenEncrypted = current.meta.pageAccessTokenEncrypted ||
      (current.meta.pageAccessTokenEnv && !looksLikeEnvName(current.meta.pageAccessTokenEnv) ? encryptSecret(current.meta.pageAccessTokenEnv) : "");
  } else {
    prepared.meta.pageAccessTokenEncrypted = encryptSecret(directPageToken);
  }
  delete prepared.meta.pageAccessTokenValue;
  delete prepared.meta.hasPageAccessToken;

  if (prepared.meta.pageAccessTokenEnv && !looksLikeEnvName(prepared.meta.pageAccessTokenEnv)) {
    prepared.meta.pageAccessTokenEncrypted = encryptSecret(prepared.meta.pageAccessTokenEnv);
    prepared.meta.pageAccessTokenEnv = current.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
  }

  prepared.channels = (prepared.channels || []).map((channel, index) => {
    const currentChannel = (current.channels || []).find((item) => item.id === channel.id) || current.channels?.[index] || {};
    const next = { ...channel };
    const directToken = next.pageAccessTokenValue;
    if (shouldPreserveSecretInput(directToken)) {
      next.pageAccessTokenEncrypted = currentChannel.pageAccessTokenEncrypted ||
        (currentChannel.pageAccessTokenEnv && !looksLikeEnvName(currentChannel.pageAccessTokenEnv) ? encryptSecret(currentChannel.pageAccessTokenEnv) : "");
    } else {
      next.pageAccessTokenEncrypted = encryptSecret(directToken);
    }
    delete next.pageAccessTokenValue;
    delete next.hasPageAccessToken;

    if (next.pageAccessTokenEnv && !looksLikeEnvName(next.pageAccessTokenEnv)) {
      next.pageAccessTokenEncrypted = encryptSecret(next.pageAccessTokenEnv);
      next.pageAccessTokenEnv = currentChannel.pageAccessTokenEnv || prepared.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
    }
    return next;
  });

  prepared.ai ||= {};
  current.ai ||= {};
  const directAiKey = prepared.ai.apiKeyValue;
  if (shouldPreserveSecretInput(directAiKey)) {
    prepared.ai.apiKeyEncrypted = current.ai.apiKeyEncrypted ||
      (current.ai.apiKeyEnv && !looksLikeEnvName(current.ai.apiKeyEnv) ? encryptSecret(current.ai.apiKeyEnv) : "");
  } else {
    prepared.ai.apiKeyEncrypted = encryptSecret(directAiKey);
  }
  delete prepared.ai.apiKeyValue;
  delete prepared.ai.hasApiKey;

  if (prepared.ai.apiKeyEnv && !looksLikeEnvName(prepared.ai.apiKeyEnv)) {
    prepared.ai.apiKeyEncrypted = encryptSecret(prepared.ai.apiKeyEnv);
    prepared.ai.apiKeyEnv = current.ai.apiKeyEnv ||
      (prepared.ai.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY");
  }

  return prepared;
}

function publicConfig(config) {
  const visible = structuredClone(config || {});
  visible.meta ||= {};
  const hasLegacyAppSecret = Boolean(visible.meta.appSecretEnv && !looksLikeEnvName(visible.meta.appSecretEnv));
  const hasLegacyPageToken = Boolean(visible.meta.pageAccessTokenEnv && !looksLikeEnvName(visible.meta.pageAccessTokenEnv));
  visible.meta.hasAppSecret = hasStoredSecret(visible.meta.appSecretEncrypted) || hasLegacyAppSecret;
  visible.meta.hasPageAccessToken = hasStoredSecret(visible.meta.pageAccessTokenEncrypted) || hasLegacyPageToken;
  visible.meta.appSecretValue = "";
  visible.meta.pageAccessTokenValue = "";
  if (hasLegacyAppSecret) visible.meta.appSecretEnv = "META_APP_SECRET";
  if (hasLegacyPageToken) visible.meta.pageAccessTokenEnv = "META_PAGE_ACCESS_TOKEN";
  delete visible.meta.appSecretEncrypted;
  delete visible.meta.pageAccessTokenEncrypted;

  visible.channels = (visible.channels || []).map((channel) => {
    const next = { ...channel };
    const hasLegacyChannelToken = Boolean(next.pageAccessTokenEnv && !looksLikeEnvName(next.pageAccessTokenEnv));
    next.hasPageAccessToken = hasStoredSecret(next.pageAccessTokenEncrypted) || hasLegacyChannelToken;
    next.pageAccessTokenValue = "";
    if (hasLegacyChannelToken) next.pageAccessTokenEnv = visible.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
    delete next.pageAccessTokenEncrypted;
    return next;
  });

  visible.ai ||= {};
  const hasLegacyAiKey = Boolean(visible.ai.apiKeyEnv && !looksLikeEnvName(visible.ai.apiKeyEnv));
  visible.ai.hasApiKey = hasStoredSecret(visible.ai.apiKeyEncrypted) || hasLegacyAiKey;
  visible.ai.apiKeyValue = "";
  if (hasLegacyAiKey) visible.ai.apiKeyEnv = visible.ai.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  delete visible.ai.apiKeyEncrypted;
  delete visible.ai.apiKeyEnv;

  if (visible.handoff?.ticketing) {
    delete visible.handoff.ticketing.webhookUrlEnv;
  }
  if (visible.integrations?.googleSheets) {
    delete visible.integrations.googleSheets.webhookUrlEnv;
  }

  return visible;
}

function isPublicAsset(pathname) {
  return pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/login.html" ||
    pathname === "/login.js" ||
    pathname === "/landing.js" ||
    pathname === "/client.html" ||
    pathname === "/client-app.js" ||
    pathname === "/privacy.html" ||
    pathname === "/delete-data.html" ||
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
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
