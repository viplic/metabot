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
