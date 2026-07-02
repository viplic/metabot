import { getAdminToken, getAppSecret, getVerifyToken, shouldRequireSignature } from "./security.js";
import { getPageAccessToken } from "./meta-client.js";
import { getAiApiKey } from "./ai-client.js";

export function evaluateReadiness(config) {
  const checks = [];
  const adminToken = getAdminToken();
  const appSecret = getAppSecret(config);

  checks.push(check("admin_token", isRealSecret(adminToken, "change-this-admin-token"), "ADMIN_TOKEN is required before public exposure."));
  checks.push(check("secret_encryption_key", isRealSecret(process.env.SECRET_ENCRYPTION_KEY || process.env.DATA_ENCRYPTION_KEY), "SECRET_ENCRYPTION_KEY must be set so stored Meta/API tokens survive admin password changes."));
  checks.push(check("graph_api_version", /^v\d+\.\d+$/.test(config.meta.graphApiVersion || ""), "Graph API version must be pinned, e.g. v25.0."));
  checks.push(check("verify_token", getVerifyToken(config) !== "change-this-token", "META_VERIFY_TOKEN must be changed."));
  checks.push(check("webhook_signature", shouldRequireSignature(config), "META_REQUIRE_SIGNATURE should be true."));
  checks.push(check("app_secret", !shouldRequireSignature(config) || isRealSecret(appSecret, "change-this-app-secret"), "META_APP_SECRET is required for webhook signature verification."));
  checks.push(check("privacy_url", Boolean(config.business.privacyNoticeUrl), "Privacy notice URL is required for launch."));
  checks.push(check("data_deletion_url", Boolean(config.business.dataDeletionUrl), "Data deletion URL/callback is required for launch."));
  checks.push(check("channels", config.channels.some((channel) => channel.enabled), "At least one channel must be enabled."));

  for (const channel of config.channels.filter((item) => item.enabled && item.sendEnabled)) {
    const tokenEnv = channel.pageAccessTokenEnv || config.meta.pageAccessTokenEnv || "META_PAGE_ACCESS_TOKEN";
    const { accessToken, source } = getPageAccessToken(config, channel);
    checks.push(check(`channel_token_${channel.id}`, isRealSecret(accessToken, "page-token-for-sending"), `${source || tokenEnv} is required for sending on ${channel.name}.`));
  }

  if (config.ai.enabled) {
    const apiKeyEnv = config.ai.apiKeyEnv || (config.ai.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY");
    checks.push(check("ai_api_key", isRealSecret(getAiApiKey(config, apiKeyEnv)), "AI API key is required when AI fallback is enabled."));
    checks.push(check("ai_model", Boolean(config.ai.model), "AI model must be configured."));
  }

  if (config.handoff.ticketing.enabled) {
    const webhookEnv = config.handoff.ticketing.webhookUrlEnv || "TICKETING_WEBHOOK_URL";
    checks.push(check("ticketing_webhook", isRealSecret(config.handoff.ticketing.webhookUrl || process.env[webhookEnv]), "Ticketing webhook URL is required when ticketing webhook is enabled."));
  }

  checks.push(check("retention", Number(config.privacy.retentionDays) > 0, "Retention must be a positive number of days."));
  checks.push(check("raw_event_privacy", !config.privacy.storeRawEvents || config.privacy.redactLogs, "Raw event storage should be paired with log redaction."));

  const failed = checks.filter((item) => !item.ok);
  return {
    ready: failed.length === 0,
    checks,
    failed
  };
}

function check(id, ok, message) {
  return { id, ok: Boolean(ok), message };
}

function isRealSecret(value, placeholder = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (placeholder && text === placeholder) return false;
  if (/^change-this/i.test(text)) return false;
  return true;
}
