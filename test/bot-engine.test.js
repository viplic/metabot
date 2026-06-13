import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config-store.js";
import { routeIncomingMessage } from "../src/bot-engine.js";
import { verifyMetaSignature } from "../src/security.js";
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

test("AI fallback call uses correct endpoint and messages schema", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;
  let fetchedBody = null;

  globalThis.fetch = async (url, options) => {
    fetchedUrl = url.toString();
    fetchedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Mocked AI Response"
            }
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
        model: "gpt-4o-mini",
        maxInputChars: 2000,
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
    assert.equal(fetchedUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(fetchedBody.model, "gpt-4o-mini");
    assert.deepEqual(fetchedBody.messages, [
      { role: "system", content: "Sys prompt" },
      { role: "user", content: "Hello, who are you?" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

