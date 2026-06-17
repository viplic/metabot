import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, normalizeConfig } from "../src/config-store.js";
import { routeIncomingMessage } from "../src/bot-engine.js";
import { buildResponsesBody, selectOpenAiModel } from "../src/ai-client.js";
import { parseEnvLine, loadDotEnv } from "../src/env.js";
import { adminSessionValue, verifyAdminAuth, verifyMetaSignature } from "../src/security.js";
import { markEventIfNew } from "../src/storage.js";
import { evaluateReadiness } from "../src/readiness.js";
import { analyzeCommerceMessage } from "../src/order-intelligence.js";
import { catalogToKnowledgeDocuments } from "../src/site-crawler.js";
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
          model: "gpt-4.1-mini",
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
        model: "gpt-4.1-mini",
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
    assert.equal(fetchedBody.model, "gpt-4.1-mini");
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

test("OpenAI gpt-5 models omit unsupported temperature parameter", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedBody = null;

  globalThis.fetch = async (url, options) => {
    fetchedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_gpt5_test",
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }]
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
        modelRouting: { enabled: false },
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

    await routeIncomingMessage({
      text: "Hello",
      config,
      conversation: { profile: {}, messages: [], audit: [] },
      channelType: "messenger"
    });

    assert.equal(fetchedBody.model, "gpt-5.5");
    assert.equal("temperature" in fetchedBody, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("OpenAI fallback sends image attachments through Responses API", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === "https://cdn.example.com/photo.jpg") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg", "content-length": "4" }),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_vision_test",
          model: "gpt-4.1-mini",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Vidim sliku. Kako mogu da pomognem?"
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
        model: "gpt-4.1-mini",
        maxInputChars: 2000,
        maxOutputTokens: 500,
        maxContextChars: 4000,
        maxHistoryChars: 1600,
        maxImages: 3,
        maxImageBytes: 1024,
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
      text: "Sta je na slici?",
      attachments: [{ type: "image", url: "https://cdn.example.com/photo.jpg", mimeType: "image/jpeg" }],
      config,
      conversation,
      channelType: "messenger"
    });

    const openAiCall = calls[1];
    const openAiBody = JSON.parse(openAiCall.options.body);
    assert.equal(result.action, "reply");
    assert.equal(result.reason, "ai_vision_fallback");
    assert.equal(result.reply, "Vidim sliku. Kako mogu da pomognem?");
    assert.equal(openAiCall.url, "https://api.openai.com/v1/responses");
    assert.equal(openAiBody.input[0].content[0].type, "input_text");
    assert.equal(openAiBody.input[0].content[0].text, "Sta je na slici?");
    assert.equal(openAiBody.input[0].content[1].type, "input_image");
    assert.match(openAiBody.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("OpenAI model routing selects models by prompt complexity", () => {
  const config = {
    ai: {
      model: "gpt-5.5",
      modelRouting: {
        enabled: true,
        simpleModel: "gpt-5.4-nano",
        standardModel: "gpt-5.4-mini",
        complexModel: "gpt-5.5",
        visionModel: "gpt-5.5",
        standardMinChars: 40,
        complexMinChars: 120,
        complexKeywords: ["analiziraj", "strategija"]
      }
    }
  };

  assert.deepEqual(selectOpenAiModel({ text: "Cena?", config }), {
    level: "simple",
    model: "gpt-5.4-nano",
    reasons: ["short_prompt"]
  });

  assert.equal(
    selectOpenAiModel({
      text: "Kako mogu da zakazem termin za sledecu nedelju i sta treba da pripremim?",
      config
    }).model,
    "gpt-5.4-mini"
  );

  assert.equal(
    selectOpenAiModel({
      text: "Analiziraj ovaj problem i napravi strategija odgovor za nezadovoljnog kupca.",
      config
    }).model,
    "gpt-5.5"
  );

  assert.deepEqual(selectOpenAiModel({ text: "Sta je ovo?", imageParts: [{ type: "input_image" }], config }), {
    level: "vision",
    model: "gpt-5.5",
    reasons: ["image_attachment"]
  });
});

test("OpenAI fallback request uses routed model", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedBody = null;

  globalThis.fetch = async (url, options) => {
    fetchedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_routed_test",
          model: fetchedBody.model,
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Routed response" }]
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
        modelRouting: {
          enabled: true,
          simpleModel: "gpt-5.4-nano",
          standardModel: "gpt-5.4-mini",
          complexModel: "gpt-5.5",
          visionModel: "gpt-5.5",
          standardMinChars: 40,
          complexMinChars: 120,
          complexKeywords: ["analiziraj"]
        },
        maxInputChars: 2000,
        maxOutputTokens: 500,
        maxContextChars: 4000,
        maxHistoryChars: 1600,
        maxImages: 3,
        maxImageBytes: 1024,
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

    const result = await routeIncomingMessage({
      text: "Cena?",
      config,
      conversation: { profile: {}, messages: [], audit: [] },
      channelType: "messenger"
    });

    assert.equal(fetchedBody.model, "gpt-5.4-nano");
    assert.equal(result.modelRouting.level, "simple");
    assert.equal(result.modelRouting.model, "gpt-5.4-nano");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("normalizes AI settings to smart low-spend defaults and caps", () => {
  const config = normalizeConfig({
    business: { defaultReply: "Default" },
    meta: {},
    channels: [],
    automation: { rules: [], faqs: [], collectFields: [], handoffKeywords: [], riskyKeywords: [] },
    knowledge: { documents: [] },
    ai: {
      enabled: true,
      provider: "openai",
      model: "gpt-5.5",
      apiKeyEnv: "OPENAI_API_KEY",
      maxInputChars: 9000,
      maxOutputTokens: 900,
      maxContextChars: 12000,
      maxHistoryChars: 9000,
      maxImages: 9,
      maxImageBytes: 99 * 1024 * 1024,
      temperature: 1.5,
      modelRouting: {
        enabled: true,
        simpleModel: "gpt-5.4-nano",
        standardModel: "gpt-5.4-mini",
        complexModel: "gpt-5.5",
        visionModel: "gpt-5.5",
        standardMinChars: 1,
        complexMinChars: 100
      }
    },
    catalog: {},
    orders: {},
    usage: {},
    integrations: {},
    handoff: { ticketing: {} },
    privacy: {}
  });

  assert.equal(config.ai.maxInputChars, 1800);
  assert.equal(config.ai.maxOutputTokens, 320);
  assert.equal(config.ai.maxContextChars, 2600);
  assert.equal(config.ai.maxHistoryChars, 900);
  assert.equal(config.ai.maxImages, 2);
  assert.equal(config.ai.maxImageBytes, 3 * 1024 * 1024);
  assert.equal(config.ai.temperature, 0.15);
  assert.equal(config.ai.modelRouting.standardMinChars, 280);
  assert.equal(config.ai.modelRouting.complexMinChars, 1200);
  assert.match(config.ai.systemPrompt, /Nikad ne koristi informacije drugih klijenata/);
});

test("OpenAI prompt is isolated to the current tenant", () => {
  const body = buildResponsesBody({
    text: "Koliko kosta dostava?",
    model: "gpt-5.5",
    config: {
      business: {
        name: "Shop Alfa",
        defaultReply: "Default"
      },
      ai: {
        model: "gpt-5.5",
        maxInputChars: 1800,
        maxOutputTokens: 320,
        maxContextChars: 2600,
        maxHistoryChars: 900,
        temperature: 0.15,
        systemPrompt: "Sys prompt"
      },
      automation: {},
      catalog: {},
      orders: {}
    },
    conversation: { platformUserId: "user-1", messages: [] },
    knowledgeMatches: []
  });

  assert.match(body.instructions, /samo klijentu: Shop Alfa/);
  assert.match(body.instructions, /Ne koristi informacije, cene, proizvode, politiku ili istoriju drugih klijenata/);
  assert.equal(body.max_output_tokens, 320);
  assert.equal(body.store, false);
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

test("normalizes Meta image attachments into incoming events", async () => {
  const { normalizeMetaPayload } = await import("../src/meta-client.js");
  const events = normalizeMetaPayload({
    object: "page",
    entry: [
      {
        id: "page-1",
        messaging: [
          {
            sender: { id: "user-1" },
            recipient: { id: "page-1" },
            timestamp: 123,
            message: {
              mid: "mid-1",
              attachments: [
                {
                  type: "image",
                  payload: {
                    url: "https://cdn.example.com/photo.jpg"
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].text, "");
  assert.deepEqual(events[0].attachments, [
    {
      type: "image",
      url: "https://cdn.example.com/photo.jpg",
      mimeType: "image/jpeg"
    }
  ]);
});

test("normalizes Meta quick replies and ignores non-user messaging events", async () => {
  const { normalizeMetaPayload } = await import("../src/meta-client.js");
  const events = normalizeMetaPayload({
    object: "page",
    entry: [
      {
        id: "page-1",
        messaging: [
          {
            sender: { id: "user-1" },
            recipient: { id: "page-1" },
            timestamp: 123,
            message: {
              mid: "mid-quick",
              quick_reply: {
                title: "Porudzbina",
                payload: "ORDER_START"
              }
            }
          },
          {
            sender: { id: "page-1" },
            recipient: { id: "user-1" },
            timestamp: 124,
            message: {
              mid: "mid-echo",
              is_echo: true,
              text: "Echo should be ignored"
            }
          },
          {
            sender: { id: "user-1" },
            recipient: { id: "page-1" },
            timestamp: 125,
            read: { watermark: 125 }
          },
          {
            sender: { id: "user-1" },
            recipient: { id: "page-1" },
            timestamp: 126,
            delivery: { mids: ["mid-quick"] }
          }
        ]
      }
    ]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].id, "mid-quick");
  assert.equal(events[0].text, "ORDER_START");
});

test("commerce analyzer detects incomplete orders and missing fields", () => {
  const result = analyzeCommerceMessage({
    text: "Hocu da porucim crvenu majicu, telefon 064 123 4567",
    conversation: { profile: {} },
    config: { orders: { requiredFields: ["name", "phone", "street", "city", "postalCode", "product"] } },
    catalog: { products: [{ name: "crvenu majicu", price: "1990 RSD" }] }
  });

  assert.equal(result.intent, "order");
  assert.equal(result.extracted.customer.phone, "064 123 4567");
  assert.equal(result.extracted.product.name, "crvenu majicu");
  assert.ok(result.missingFields.includes("name"));
  assert.ok(result.missingFields.includes("street"));
});

test("commerce analyzer links product images to catalog price and note metadata", () => {
  const commerce = analyzeCommerceMessage({
    text: "Hocu ovo, tekst na proizvodu: Srecan rodjendan",
    attachments: [
      {
        type: "image",
        url: "https://shop.example.com/cdn/products/majica-alfa.jpg?width=900",
        mimeType: "image/jpeg"
      }
    ],
    catalog: {
      products: [
        {
          name: "Majica Alfa",
          price: "2400 RSD",
          url: "https://shop.example.com/products/majica-alfa",
          image: "https://shop.example.com/cdn/products/majica-alfa.jpg"
        }
      ]
    },
    config: {
      orders: { requiredFields: ["product"] }
    }
  });

  assert.equal(commerce.intent, "order");
  assert.equal(commerce.extracted.product.name, "Majica Alfa");
  assert.equal(commerce.extracted.product.price, "2400 RSD");
  assert.equal(commerce.extracted.product.matchSource, "image_url");
  assert.equal(commerce.extracted.product.matchConfidence, 0.98);
  assert.equal(commerce.missingFields.length, 0);
});

test("OpenAI vision prompt includes compact product image catalog", () => {
  const body = buildResponsesBody({
    text: "Koja je cena?",
    imageParts: [{ type: "input_image", image_url: "data:image/jpeg;base64,AAAA" }],
    model: "gpt-5.5",
    config: {
      business: { name: "Shop Alfa", defaultReply: "Default" },
      ai: {
        model: "gpt-5.5",
        maxInputChars: 1800,
        maxOutputTokens: 320,
        maxContextChars: 2600,
        maxHistoryChars: 900,
        temperature: 0.15,
        systemPrompt: "Sys prompt"
      },
      automation: {},
      catalog: {
        products: [
          {
            name: "Majica Alfa",
            price: "2400 RSD",
            url: "https://shop.example.com/products/majica-alfa",
            image: "https://shop.example.com/cdn/products/majica-alfa.jpg"
          }
        ]
      },
      orders: {}
    },
    conversation: { platformUserId: "user-1", messages: [] },
    knowledgeMatches: []
  });

  assert.match(body.instructions, /Katalog proizvoda za prepoznavanje slika/);
  assert.match(body.instructions, /Majica Alfa/);
  assert.match(body.instructions, /2400 RSD/);
});

test("catalog snapshots convert into knowledge documents", () => {
  const docs = catalogToKnowledgeDocuments({
    products: [{ name: "Majica", price: "1990 RSD", description: "Pamucna majica", url: "https://shop.test/majica" }],
    policies: [{ title: "Dostava", keywords: ["dostava"], content: "Dostava je 350 RSD." }]
  });

  assert.equal(docs.length, 2);
  assert.match(docs[0].content, /1990 RSD/);
  assert.equal(docs[1].title, "Dostava");
});

test("Gemini fallback sends text and images through generateContent", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === "https://cdn.example.com/photo.jpg") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg", "content-length": "4" }),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          responseId: "gemini-test",
          candidates: [
            {
              content: {
                parts: [{ text: "Vidim sliku. Kako mogu da pomognem?" }]
              }
            }
          ]
        })
    };
  };

  try {
    process.env.GEMINI_API_KEY = "mock-gemini-key";
    const config = {
      ai: {
        enabled: true,
        provider: "gemini",
        apiKeyEnv: "GEMINI_API_KEY",
        model: "gemini-2.5-flash",
        maxInputChars: 2000,
        maxOutputTokens: 500,
        maxContextChars: 4000,
        maxHistoryChars: 1600,
        maxImages: 3,
        maxImageBytes: 1024,
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
      text: "Sta je na slici?",
      attachments: [{ type: "image", url: "https://cdn.example.com/photo.jpg", mimeType: "image/jpeg" }],
      config,
      conversation,
      channelType: "messenger"
    });

    const geminiCall = calls[1];
    const geminiBody = JSON.parse(geminiCall.options.body);
    assert.equal(result.action, "reply");
    assert.equal(result.reason, "ai_vision_fallback");
    assert.equal(result.reply, "Vidim sliku. Kako mogu da pomognem?");
    assert.match(geminiCall.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/);
    assert.equal(geminiBody.contents[0].parts[0].text, "Sta je na slici?");
    assert.equal(geminiBody.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
    assert.ok(geminiBody.contents[0].parts[1].inlineData.data);
    assert.match(geminiBody.systemInstruction.parts[0].text, /Sys prompt/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
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
      verifyAdminAuth({ cookie: `nibachat_admin=${adminSessionValue("admin-secret")}` }).ok,
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
