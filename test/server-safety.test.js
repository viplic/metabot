import test from "node:test";
import assert from "node:assert/strict";
import { routeIncomingMessage } from "../src/bot-engine.js";

test("test message config disables AI fallback unless explicitly allowed", async () => {
  process.env.VERCEL = "1";
  process.env.OPENAI_API_KEY = "mock-key";
  const { testMessageConfig } = await import("../src/server.js");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("AI should not be called for default test messages");
  };

  try {
    const config = testMessageConfig({
      automation: {
        enabled: true,
        rules: [],
        faqs: [],
        collectFields: [],
        handoffKeywords: [],
        riskyKeywords: [],
        confidenceThreshold: 0.72,
        leadCapturePrompt: "Ostavite {field}."
      },
      business: {
        defaultReply: "Default reply"
      },
      knowledge: {
        enabled: true,
        documents: [],
        minScore: 0.35,
        autoReplyThreshold: 0.82
      },
      ai: {
        enabled: true,
        provider: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-4.1-mini"
      },
      catalog: {},
      handoff: { enabled: true }
    });

    const result = await routeIncomingMessage({
      text: "Random pitanje koje nema pravilo",
      config,
      conversation: { profile: {}, messages: [], audit: [] },
      channelType: "messenger"
    });

    assert.equal(config.ai.enabled, false);
    assert.equal(result.reason, "default_reply");
    assert.equal(result.reply, "Default reply");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("test message config keeps AI enabled only when admin allows it", async () => {
  process.env.VERCEL = "1";
  const { testMessageConfig } = await import("../src/server.js");
  const config = { ai: { enabled: true } };

  assert.equal(testMessageConfig(config).ai.enabled, false);
  assert.equal(testMessageConfig(config, { allowAi: true }).ai.enabled, true);
});
