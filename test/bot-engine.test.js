import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config-store.js";
import { routeIncomingMessage } from "../src/bot-engine.js";
import { parseEnvLine, loadDotEnv } from "../src/env.js";
import { verifyAdminAuth, verifyMetaSignature } from "../src/security.js";
import { markEventIfNew } from "../src/storage.js";
import { evaluateReadiness } from "../src/readiness.js";
import crypto from "node:crypto";

test("matches configured rule before fallback", async () => {
  const config = await loadConfig();
  const conversation = { profile: {}, messages: [], audit: [] };
  const result = await routeIncomingMessage({
    text: "Koje je radno vreme?",
    config,
    conversation,
    channelType: "messenger"
  });

  assert.equal(result.action, "reply");
  assert.equal(result.reason, "rule");
  assert.match(result.reply, /Radimo/);
});

test("handoff keyword triggers human handoff", async () => {
  const config = await loadConfig();
  const conversation = { profile: {}, messages: [], audit: [] };
  const result = await routeIncomingMessage({
    text: "Hocu operater",
    config,
    conversation,
    channelType: "messenger"
  });

  assert.equal(result.action, "handoff");
  assert.equal(result.reason, "handoff_keyword");
});

test("validates Meta signature", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify({ object: "page" }));
  const signature =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(body, "sha256=bad", secret), false);
});

test("AI fallback call uses Responses API with instructions and safe storage settings", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;
  let fetchedBody = null;

  globalThis.fetch = async (url, options) => {
    fetchedUrl = url.toString();
    fetchedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_test",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Mocked AI Response"
                }
              ]
            }
          ]
        })
    };
  };

  try {
    process.env.OPENAI_API_KEY = "mock-key";
    const config = {
      ai: {
        enabled: true,
        provider: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-5.5",
        maxInputChars: 2000,
        maxOutputTokens: 500,
        maxContextChars: 4000,
        temperature: 0.2,
        systemPrompt: "Sys prompt",
        fallbackToHumanOnError: false
      },
      automation: {
        enabled: true,
        rules: [],
        faqs: [],
        collectFields: []
      },
      business: {
        defaultReply: "Default"
      }
    };

    const conversation = { profile: {}, messages: [], audit: [] };
    const result = await routeIncomingMessage({
      text: "Hello, who are you?",
      config,
      conversation,
      channelType: "messenger"
    });

    assert.equal(result.action, "reply");
    assert.equal(result.reason, "ai_fallback");
    assert.equal(result.reply, "Mocked AI Response");
    assert.equal(fetchedUrl, "https://api.openai.com/v1/responses");
    assert.equal(fetchedBody.model, "gpt-5.5");
    assert.equal(fetchedBody.input, "Hello, who are you?");
    assert.equal(fetchedBody.store, false);
    assert.equal(fetchedBody.max_output_tokens, 500);
    assert.match(fetchedBody.instructions, /Sys prompt/);
    assert.match(fetchedBody.safety_identifier, /^[a-f0-9]{32}$/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("knowledge retrieval can answer before AI fallback", async () => {
  const config = await loadConfig();
  const conversation = { profile: {}, messages: [], audit: [] };
  const result = await routeIncomingMessage({
    text: "Kako ide brisanje podataka i privatnost?",
    config,
    conversation,
    channelType: "messenger"
  });

  assert.equal(result.action, "reply");
  assert.equal(result.reason, "knowledge");
  assert.match(result.reply, /brisanje podataka/i);
});

test("blocks automated send outside the 24h policy window and opens handoff path", async () => {
  const config = await loadConfig();
  const conversation = { profile: {}, messages: [], audit: [] };
  const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000;

  const result = await routeIncomingMessage({
    text: "Koje je radno vreme?",
    config,
    conversation,
    channelType: "messenger",
    eventTimestamp: oldTimestamp
  });

  assert.equal(result.action, "handoff");
  assert.equal(result.reason, "outside_policy_window");
  assert.equal(result.sendAllowed, false);
  assert.equal(result.reply, "");
});

test("parses and loads .env values without overriding existing env", async () => {
  assert.deepEqual(parseEnvLine("ADMIN_TOKEN=\"secret value\""), {
    key: "ADMIN_TOKEN",
    value: "secret value"
  });
  assert.equal(parseEnvLine("# ignored"), null);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "metabot-env-"));
  const envPath = path.join(dir, ".env");
  await fs.writeFile(envPath, "METABOT_ENV_TEST=from-file\nMETABOT_ENV_KEEP=from-file\n", "utf8");

  process.env.METABOT_ENV_KEEP = "already-set";
  try {
    const result = await loadDotEnv(envPath);
    assert.equal(result.loaded, 1);
    assert.equal(process.env.METABOT_ENV_TEST, "from-file");
    assert.equal(process.env.METABOT_ENV_KEEP, "already-set");
  } finally {
    delete process.env.METABOT_ENV_TEST;
    delete process.env.METABOT_ENV_KEEP;
  }
});

test("validates admin auth with bearer, basic and x-admin-token", () => {
  process.env.ADMIN_USERNAME = "owner";
  process.env.ADMIN_TOKEN = "admin-secret";

  try {
    assert.equal(
      verifyAdminAuth({ authorization: "Bearer admin-secret" }).ok,
      true
    );
    assert.equal(
      verifyAdminAuth({ "x-admin-token": "admin-secret" }).ok,
      true
    );
    assert.equal(
      verifyAdminAuth({
        authorization: `Basic ${Buffer.from("owner:admin-secret").toString("base64")}`
      }).ok,
      true
    );
    assert.equal(
      verifyAdminAuth({ authorization: "Bearer wrong" }).ok,
      false
    );
  } finally {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_TOKEN;
  }
});

test("readiness reports missing launch requirements", async () => {
  const config = await loadConfig();
  const result = evaluateReadiness({
    ...config,
    business: { ...config.business, privacyNoticeUrl: "", dataDeletionUrl: "" },
    meta: { ...config.meta, verifyToken: "change-this-token", requireSignature: true }
  });

  assert.equal(result.ready, false);
  assert.ok(result.failed.some((item) => item.id === "admin_token"));
  assert.ok(result.failed.some((item) => item.id === "privacy_url"));
  assert.ok(result.failed.some((item) => item.id === "data_deletion_url"));
});

test("deduplicates processed webhook event IDs", async () => {
  const eventId = `test-event-${Date.now()}-${Math.random()}`;
  assert.equal(await markEventIfNew(eventId, 1), true);
  assert.equal(await markEventIfNew(eventId, 1), false);
});

test("fetchMetaUserProfile sends correct request and handles Facebook / Instagram profiles", async () => {
  const { fetchMetaUserProfile } = await import("../src/meta-client.js");
  const originalFetch = globalThis.fetch;
  let fetchedUrls = [];

  globalThis.fetch = async (url) => {
    fetchedUrls.push(url.toString());
    const urlObj = new URL(url);
    if (urlObj.pathname.includes("messenger-user")) {
      return {
        ok: true,
        json: async () => ({
          first_name: "John",
          last_name: "Doe",
          profile_pic: "http://messenger/avatar.jpg"
        })
      };
    } else {
      return {
        ok: true,
        json: async () => ({
          username: "johndoe_ig",
          name: "John Doe IG",
          profile_pic: "http://instagram/avatar.jpg"
        })
      };
    }
  };

  try {
    process.env.META_PAGE_ACCESS_TOKEN = "test-token";
    const config = {
      meta: {
        graphApiVersion: "v25.0",
        appSecretEnv: "META_APP_SECRET",
        pageAccessTokenEnv: "META_PAGE_ACCESS_TOKEN"
      }
    };
    process.env.META_APP_SECRET = "test-secret";

    // 1) Test Messenger channel profile
    const messengerChannel = { type: "messenger" };
    const messengerProfile = await fetchMetaUserProfile({
      config,
      channel: messengerChannel,
      platformUserId: "messenger-user"
    });

    assert.equal(messengerProfile.name, "John Doe");
    assert.equal(messengerProfile.avatar, "http://messenger/avatar.jpg");

    // 2) Test Instagram channel profile
    const instagramChannel = { type: "instagram" };
    const instagramProfile = await fetchMetaUserProfile({
      config,
      channel: instagramChannel,
      platformUserId: "instagram-user"
    });

    assert.equal(instagramProfile.name, "John Doe IG");
    assert.equal(instagramProfile.username, "johndoe_ig");
    assert.equal(instagramProfile.avatar, "http://instagram/avatar.jpg");

    // Check URLs
    assert.ok(fetchedUrls[0].includes("https://graph.facebook.com/v25.0/messenger-user"));
    assert.ok(fetchedUrls[0].includes("fields=first_name%2Clast_name%2Cprofile_pic"));
    assert.ok(fetchedUrls[0].includes("appsecret_proof="));

    assert.ok(fetchedUrls[1].includes("https://graph.facebook.com/v25.0/instagram-user"));
    assert.ok(fetchedUrls[1].includes("fields=name%2Cusername%2Cprofile_pic"));
    assert.ok(fetchedUrls[1].includes("appsecret_proof="));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_APP_SECRET;
  }
});
