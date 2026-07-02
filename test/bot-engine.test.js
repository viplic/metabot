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

test("image price questions use AI vision before generic knowledge fallback", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === "https://cdn.example.com/unknown-product.jpg") {
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
          id: "resp_vision_price",
          model: "gpt-4.1-mini",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Ovo izgleda kao medaljon i cena je 38,90 KM. Ako želite da poručite, ostavite nam vaše podatke."
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
      },
      knowledge: {
        enabled: true,
        documents: [
          {
            id: "generic-image-answer",
            enabled: true,
            title: "Genericki odgovor za slike",
            keywords: ["slika", "ovo", "cena"],
            content: "Napišite mi naziv proizvoda ili pošaljite sliku, pa ću vam odmah reći tačnu cenu."
          }
        ]
      },
      catalog: {
        products: []
      }
    };

    const result = await routeIncomingMessage({
      text: "Koliko kosta ovo?",
      attachments: [{ type: "image", url: "https://cdn.example.com/unknown-product.jpg", mimeType: "image/jpeg" }],
      config,
      conversation: { profile: {}, messages: [], audit: [] },
      channelType: "instagram"
    });

    assert.equal(result.action, "reply");
    assert.equal(result.reason, "ai_vision_fallback");
    assert.match(result.reply, /38,90 KM/);
    assert.doesNotMatch(result.reply, /pošaljite sliku/i);
    assert.equal(calls.some((call) => call.url === "https://api.openai.com/v1/responses"), true);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("unavailable image attachments do not force handoff", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === "https://cdn.example.com/missing.jpg") {
      return {
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_text_after_bad_image",
          model: "gpt-4.1-mini",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Pošaljite naziv proizvoda ili novu sliku, pa proveravam cenu."
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
        fallbackToHumanOnError: true
      },
      automation: {
        enabled: true,
        rules: [],
        faqs: [],
        collectFields: []
      },
      handoff: {
        enabled: true,
        message: "Prosleđujem timu."
      },
      business: {
        defaultReply: "Default"
      },
      knowledge: {
        enabled: true,
        documents: []
      },
      catalog: {
        products: []
      }
    };

    const result = await routeIncomingMessage({
      text: "Koliko kosta ovo?",
      attachments: [{ type: "image", url: "https://cdn.example.com/missing.jpg", mimeType: "image/jpeg" }],
      config,
      conversation: { profile: {}, messages: [], audit: [] },
      channelType: "instagram"
    });

    assert.equal(result.action, "reply");
    assert.equal(result.reason, "ai_fallback");
    assert.notEqual(result.action, "handoff");
    assert.equal(calls.some((call) => call.url === "https://api.openai.com/v1/responses"), true);
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

test("product knowledge auto replies stay concise and hide links", async () => {
  const config = {
    business: { defaultReply: "Default", salesCta: "Ako želite da poručite, ostavite nam vaše podatke." },
    automation: {
      enabled: true,
      handoffKeywords: [],
      riskyKeywords: [],
      rules: [],
      faqs: [],
      confidenceThreshold: 0.72,
      collectFields: []
    },
    knowledge: {
      enabled: true,
      minScore: 0.2,
      autoReplyThreshold: 0.75,
      maxMatches: 4,
      documents: [
        {
          id: "product-majica",
          enabled: true,
          title: "Majica Alfa",
          keywords: ["Majica Alfa", "1990 RSD"],
          content: "Proizvod: Majica Alfa\nCena: 1990 RSD\nOpis: Pamucna majica\nURL: https://shop.test/majica\nSlika: https://shop.test/majica.jpg",
          response: ""
        }
      ]
    },
    orders: {},
    ai: { enabled: false },
    catalog: {},
    handoff: { enabled: false }
  };

  const result = await routeIncomingMessage({
    text: "Koliko kosta Majica Alfa?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(result.reason, "knowledge");
  assert.equal(result.reply, "Majica Alfa košta 1990 RSD. Ako želite da poručite, ostavite nam vaše podatke.");
  assert.doesNotMatch(result.reply, /https?:\/\//);
});

test("specific product knowledge beats generic pricing FAQ", async () => {
  const config = {
    business: {
      defaultReply: "Default",
      salesCta: "Ako želite da poručite, ostavite nam podatke ovde."
    },
    automation: {
      enabled: true,
      handoffKeywords: [],
      riskyKeywords: [],
      rules: [],
      faqs: [
        {
          id: "pricing",
          enabled: true,
          question: "Koliko kosta usluga?",
          keywords: ["cena", "cijena", "koliko kosta"],
          answer: "Cene zavise od usluge."
        }
      ],
      confidenceThreshold: 0.72,
      collectFields: []
    },
    knowledge: {
      enabled: true,
      minScore: 0.2,
      autoReplyThreshold: 0.75,
      maxMatches: 4,
      documents: [
        {
          id: "product-medaljon-graviranje",
          enabled: true,
          title: "Medaljon sa slikom - personalizovani medaljon",
          keywords: ["medaljon", "medaljona", "graviranje", "medaljon za graviranje", "ogrlica sa slikom"],
          content: "Proizvod: Medaljon sa slikom - Personalizovani medaljon\nCena: 38.90 BAM\nOpis: Personalizovani medaljon za graviranje i sliku.",
          response: "Medaljon za graviranje je 38.90 KM. Ako želite da poručite, ostavite nam podatke ovde."
        }
      ]
    },
    orders: {},
    ai: { enabled: false },
    catalog: {},
    handoff: { enabled: false }
  };

  const result = await routeIncomingMessage({
    text: "Koja je cena medaljona za graviranje?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(result.reason, "knowledge");
  assert.match(result.reply, /38\.90 KM/);
  assert.doesNotMatch(result.reply, /zavise od usluge/i);
});

test("vague price question without image does not guess a product from catalog", async () => {
  const config = {
    business: { defaultReply: "Default" },
    automation: {
      enabled: true,
      handoffKeywords: [],
      riskyKeywords: [],
      rules: [],
      faqs: [],
      confidenceThreshold: 0.72,
      collectFields: []
    },
    knowledge: {
      enabled: true,
      minScore: 0.2,
      autoReplyThreshold: 0.75,
      maxMatches: 4,
      documents: [
        {
          id: "product-majica",
          enabled: true,
          title: "Majica Alfa",
          keywords: ["Majica Alfa", "1990 RSD"],
          content: "Proizvod: Majica Alfa\nCena: 1990 RSD",
          response: ""
        }
      ]
    },
    orders: {},
    ai: { enabled: false },
    catalog: {},
    handoff: { enabled: false }
  };

  const result = await routeIncomingMessage({
    text: "Koliko je ovo?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(result.reason, "default_reply");
  assert.equal(result.reply, "Default");
});

test("image product price questions use matched catalog image before knowledge fallback", async () => {
  const config = {
    business: { defaultReply: "Default" },
    automation: {
      enabled: true,
      handoffKeywords: [],
      riskyKeywords: [],
      rules: [],
      faqs: [],
      confidenceThreshold: 0.72,
      collectFields: []
    },
    knowledge: {
      enabled: true,
      minScore: 0.2,
      autoReplyThreshold: 0.75,
      maxMatches: 4,
      documents: []
    },
    orders: { requiredFields: ["name", "phone", "street", "city", "postalCode", "product"] },
    ai: { enabled: false },
    catalog: {
      products: [
        {
          name: "Pogled koji Pamtim",
          price: "38.90 BAM",
          image: "https://cdn.shop.test/products/pogled-koji-pamtim.jpg?v=1"
        }
      ]
    },
    handoff: { enabled: false }
  };

  const result = await routeIncomingMessage({
    text: "Koliko je ovo?",
    attachments: [{ type: "image", url: "https://cdn.shop.test/products/pogled-koji-pamtim.jpg?v=2" }],
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(result.reason, "image_product_price");
  assert.equal(result.reply, "Pogled koji Pamtim košta 38,90 KM.");
});

test("product links are not sent even when customer asks for a link", async () => {
  const config = {
    business: { defaultReply: "Default" },
    automation: {
      enabled: true,
      handoffKeywords: [],
      riskyKeywords: [],
      rules: [],
      faqs: [],
      confidenceThreshold: 0.72,
      collectFields: []
    },
    knowledge: { enabled: true, minScore: 0.2, autoReplyThreshold: 0.75, maxMatches: 4, documents: [] },
    orders: {},
    ai: { enabled: false },
    catalog: {
      products: [
        {
          name: "Pogled koji Pamtim",
          price: "38.90 BAM",
          url: "https://shop.test/pogled-koji-pamtim"
        }
      ]
    },
    handoff: { enabled: false }
  };

  const withoutLinkRequest = await routeIncomingMessage({
    text: "Koliko kosta Pogled koji Pamtim?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.doesNotMatch(withoutLinkRequest.reply, /https?:\/\//);

  const withLinkRequest = await routeIncomingMessage({
    text: "Posalji mi link za Pogled koji Pamtim",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.doesNotMatch(withLinkRequest.reply, /https?:\/\//);
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

test("Instagram payloads prefer the Instagram channel over a matching Messenger page", async () => {
  const { findChannel } = await import("../src/meta-client.js");
  const config = {
    channels: [
      {
        id: "messenger",
        type: "messenger",
        enabled: true,
        pageId: "page-1"
      },
      {
        id: "instagram",
        type: "instagram",
        enabled: true,
        pageId: "page-1",
        igAccountId: "ig-1"
      }
    ]
  };

  const channel = findChannel(config, {
    channelType: "instagram",
    pageId: "page-1",
    recipientId: "ig-1"
  });

  assert.equal(channel.id, "instagram");
});

test("Instagram channel matches when Meta sends the linked Facebook page as recipient", async () => {
  const { findChannel } = await import("../src/meta-client.js");
  const config = {
    channels: [
      {
        id: "messenger",
        type: "messenger",
        enabled: true,
        pageId: "page-1"
      },
      {
        id: "instagram",
        type: "instagram",
        enabled: true,
        pageId: "page-1",
        igAccountId: "ig-1"
      }
    ]
  };

  const channel = findChannel(config, {
    channelType: "instagram",
    pageId: "page-1",
    recipientId: "page-1"
  });

  assert.equal(channel.id, "instagram");
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

test("commerce analyzer treats full customer details as an order after CTA", () => {
  const result = analyzeCommerceMessage({
    text: [
      "Ime i prezime: Ana Anic",
      "Grad: Sarajevo",
      "Postanski broj: 71000",
      "Adresa: Zmaja od Bosne 12",
      "Telefon: 061 123 456",
      "Medaljon za graviranje"
    ].join("\n"),
    config: { orders: { requiredFields: ["name", "city", "postalCode", "street", "phone", "product"] } },
    catalog: { products: [{ name: "Medaljon za graviranje", price: "38.90 BAM" }] }
  });

  assert.equal(result.intent, "order");
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.extracted.customer.name, "Ana Anic");
  assert.equal(result.extracted.delivery.city, "Sarajevo");
  assert.equal(result.extracted.delivery.postalCode, "71000");
  assert.equal(result.extracted.product.name, "Medaljon za graviranje");
  assert.equal(result.extracted.product.price, "38.90 BAM");
});

test("commerce analyzer extracts free-form order details without labels", () => {
  const result = analyzeCommerceMessage({
    text: "HOCU DA PORUCIM MEDALJON ZA GRAVIRANJE. Nikola Jakovljevic, Sarajevo 71000, Zmaja od Bosne 12, 061 123 456",
    config: { orders: { requiredFields: ["name", "city", "postalCode", "street", "phone", "product"] } },
    catalog: {
      products: [{
        name: "Medaljon za graviranje",
        price: "38.90 BAM",
        url: "https://starlightnakit.ba/products/medaljon-sa-slikom-personalizovani-medaljon"
      }]
    }
  });

  assert.equal(result.intent, "order");
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.extracted.customer.name, "Nikola Jakovljevic");
  assert.equal(result.extracted.delivery.city, "sarajevo");
  assert.equal(result.extracted.delivery.postalCode, "71000");
  assert.equal(result.extracted.delivery.street, "Zmaja od Bosne 12");
  assert.equal(result.extracted.customer.phone, "061 123 456");
  assert.equal(result.extracted.product.price, "38.90 BAM");
});

test("price question for inflected product name uses catalog price and CTA", async () => {
  const config = await loadConfig();
  config.business.salesCta = "Ako želite da poručite, ostavite nam vaše podatke.";
  config.catalog = {
    products: [{
      name: "Medaljon za graviranje",
      price: "38.90 BAM",
      url: "https://starlightnakit.ba/products/medaljon-sa-slikom-personalizovani-medaljon"
    }]
  };
  config.automation.rules = [];
  config.automation.faqs = [];
  config.knowledge.documents = [];

  const result = await routeIncomingMessage({
    text: "Koja je cena medaljona za graviranje?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(result.action, "reply");
  assert.equal(result.reason, "product_price");
  assert.equal(result.matched, "Medaljon za graviranje");
  assert.match(result.reply, /38,90 KM/);
  assert.match(result.reply, /Ako želite da poručite, ostavite nam vaše podatke\./);
  assert.doesNotMatch(result.reply, /link/i);
});

test("commerce analyzer does not collect order details for normal price questions", () => {
  const result = analyzeCommerceMessage({
    text: "Zelim samo da znam cenu dostave i da li imate ovu narukvicu?",
    conversation: { profile: {} },
    config: { orders: { requiredFields: ["name", "phone", "street", "city", "postalCode", "product"] } },
    catalog: { products: [{ name: "narukvicu", price: "2400 RSD" }] }
  });

  assert.equal(result.intent, "delivery_price");
  assert.equal(result.missingFields.length, 0);
});

test("delivery and production questions use short configured replies before generic knowledge", async () => {
  const config = await loadConfig();
  config.business.deliveryReply = "Dostava je 10 KM za celu BiH.";
  config.business.productionTimeReply = "Rok izrade i isporuke je 2-3 radna dana.";
  config.automation.rules = [];
  config.automation.faqs = [];
  config.knowledge.enabled = true;
  config.knowledge.documents = [
    {
      id: "delivery-long",
      enabled: true,
      title: "Dostava",
      keywords: ["dostava"],
      content: "Brza i sigurna dostava Nudimo brzu i pouzdanu dostavu sa pracenjem."
    }
  ];

  const delivery = await routeIncomingMessage({
    text: "Koja je cijena dostave?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.equal(delivery.reason, "delivery_price");
  assert.equal(delivery.reply, "Dostava je 10 KM za celu BiH.");

  const production = await routeIncomingMessage({
    text: "Za koliko dana stize?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.equal(production.reason, "production_time");
  assert.equal(production.reply, "Rok izrade i isporuke je 2-3 radna dana.");
});

test("exchange and payment questions use business rules before old knowledge", async () => {
  const config = await loadConfig();
  config.business.exchangeReply = "Zamena nije moguća zbog personalizacije proizvoda.";
  config.business.paymentReply = "Plaćanje je pouzećem, kuriru pri dostavi.";
  config.automation.rules = [];
  config.automation.faqs = [];
  config.knowledge.enabled = true;
  config.knowledge.documents = [
    {
      id: "bad-old-answer",
      enabled: true,
      title: "Stari odgovor",
      keywords: ["zamena", "kartica"],
      content: "Pošaljite link ili sliku proizvoda pa ćemo proveriti."
    }
  ];

  const exchange = await routeIncomingMessage({
    text: "Da li mogu zamenu?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.equal(exchange.reason, "exchange");
  assert.equal(exchange.reply, "Zamena nije moguća zbog personalizacije proizvoda.");

  const payment = await routeIncomingMessage({
    text: "Mogu li platiti karticom?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });
  assert.equal(payment.reason, "payment");
  assert.equal(payment.reply, "Plaćanje je pouzećem, kuriru pri dostavi.");
});

test("gift packaging questions use short configured replies before generic knowledge", async () => {
  const config = await loadConfig();
  config.business.giftPackagingReply = "Da, stiže u poklon kutiji. Ako želite da poručite, ostavite nam vaše podatke.";
  config.automation.rules = [];
  config.automation.faqs = [];
  config.knowledge.enabled = true;
  config.knowledge.documents = [
    {
      id: "generic-shop-faq",
      enabled: true,
      title: "Sve informacije",
      keywords: ["poklon", "kutija", "dostava", "placanje", "zamena"],
      content: "Plaćanje: pouzećem kuriru. Dostava: 10 KM za celu BiH. Rok izrade i isporuke: 2-3 radna dana. Zamena: nije moguća zbog personalizacije."
    }
  ];

  const gift = await routeIncomingMessage({
    text: "Stize li u poklon kutiji?",
    config,
    conversation: { profile: {}, messages: [], audit: [] },
    channelType: "messenger"
  });

  assert.equal(gift.reason, "gift_packaging");
  assert.equal(gift.reply, "Da, stiže u poklon kutiji. Ako želite da poručite, ostavite nam vaše podatke.");
  assert.doesNotMatch(gift.reply, /Plaćanje:/);
  assert.doesNotMatch(gift.reply, /Dostava:/);
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
