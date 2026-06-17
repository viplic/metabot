import crypto from "node:crypto";
import { buildCommerceSystemGuidance } from "./order-intelligence.js";

export async function askAiFallback({ text, attachments = [], config, conversation, knowledgeMatches = [] }) {
  if (!config.ai.enabled) return null;

  if (config.ai.provider === "gemini") {
    return askGeminiFallback({ text, attachments, config, conversation, knowledgeMatches });
  }

  if (config.ai.provider !== "openai") return null;

  const apiKey = process.env[config.ai.apiKeyEnv || "OPENAI_API_KEY"];
  if (!apiKey) {
    return handoffOrNull(config, "missing_ai_api_key");
  }

  try {
    const imageParts = await buildOpenAiImageParts(attachments, config);
    const routing = selectOpenAiModel({ text, imageParts, config, knowledgeMatches });
    const body = buildResponsesBody({ text, imageParts, config, conversation, knowledgeMatches, model: routing.model });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI Responses error ${response.status}: ${responseText.slice(0, 240)}`);
    }

    const data = responseText ? JSON.parse(responseText) : {};
    const reply = extractOutputText(data) || config.business.defaultReply;
    return {
      action: "reply",
      reply: reply.trim(),
      confidence: imageParts.length ? 0.68 : knowledgeMatches.length ? 0.7 : 0.62,
      reason: imageParts.length ? "ai_vision_fallback" : knowledgeMatches.length ? "ai_rag_fallback" : "ai_fallback",
      matched: data.model || routing.model,
      modelRouting: routing,
      aiResponseId: data.id || null
    };
  } catch (error) {
    return handoffOrNull(config, "ai_error", error.message);
  }
}

async function askGeminiFallback({ text, attachments = [], config, conversation, knowledgeMatches = [] }) {
  const apiKey = process.env[config.ai.apiKeyEnv || "GEMINI_API_KEY"];
  if (!apiKey) {
    return handoffOrNull(config, "missing_ai_api_key");
  }

  try {
    const imageParts = await buildGeminiImageParts(attachments, config);
    const body = buildGeminiBody({ text, imageParts, config, conversation, knowledgeMatches });
    const model = encodeURIComponent(config.ai.model || "gemini-2.5-flash");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini generateContent error ${response.status}: ${responseText.slice(0, 240)}`);
    }

    const data = responseText ? JSON.parse(responseText) : {};
    const reply = extractGeminiText(data) || config.business.defaultReply;
    return {
      action: "reply",
      reply: reply.trim(),
      confidence: imageParts.length ? 0.68 : knowledgeMatches.length ? 0.7 : 0.62,
      reason: imageParts.length ? "ai_vision_fallback" : knowledgeMatches.length ? "ai_rag_fallback" : "ai_fallback",
      matched: config.ai.model,
      aiResponseId: data.responseId || null
    };
  } catch (error) {
    return handoffOrNull(config, "ai_error", error.message);
  }
}

export function buildResponsesBody({ text, imageParts = [], config, conversation, knowledgeMatches = [], model = null }) {
  const context = buildKnowledgeContext(knowledgeMatches, config.ai.maxContextChars || 4000);
  const history = buildConversationHistory(conversation, config.ai.maxHistoryChars || 1600);
  const instructions = [
    config.ai.systemPrompt,
    buildCommerceSystemGuidance({ config, catalog: config.catalog || {} }),
    `Ovaj razgovor pripada samo klijentu: ${config.business?.name || "nepoznat klijent"}. Ne koristi informacije, cene, proizvode, politiku ili istoriju drugih klijenata.`,
    "Prepoznaj jezik korisnika iz poslednje poruke i odgovori istim jezikom i istim pismom kada je moguce.",
    "Odgovaraj kratko, prirodno, poslovno i bez sablonskog ponavljanja prethodnih odgovora.",
    "Ne izmisljaj cene, rokove, politiku povrata, pravne informacije ni status porudzbine.",
    "Ako korisnik pita za proizvod, cenu, dostavu, zamenu, reklamaciju ili rok izrade, koristi iskljucivo pouzdan kontekst, katalog i pravila klijenta.",
    imageParts.length ? buildProductImageCatalog(config.catalog || {}) : "",
    "Ako odgovor nije podrzan pravilima ili kontekstom, predlozi razgovor sa agentom.",
    history ? `Skorasnji tok razgovora:\n${history}` : "",
    context ? `Pouzdan kontekst iz baze znanja:\n${context}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = String(text || "").trim() || "Korisnik je poslao sliku bez dodatnog teksta. Odgovori na osnovu slike i konteksta razgovora.";
  const inputText = prompt.slice(0, config.ai.maxInputChars || 2000);

  const body = {
    model: model || config.ai.model,
    instructions,
    input: imageParts.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: inputText },
              ...imageParts
            ]
          }
        ]
      : inputText,
    store: false,
    max_output_tokens: config.ai.maxOutputTokens || 500,
    safety_identifier: stableSafetyIdentifier(conversation?.platformUserId || conversation?.id || "unknown")
  };

  if (supportsTemperature(body.model)) {
    body.temperature = config.ai.temperature ?? 0.2;
  }

  return body;
}

export function selectOpenAiModel({ text, imageParts = [], config, knowledgeMatches = [] }) {
  const routing = config.ai.modelRouting || {};
  const fallbackModel = config.ai.model || "gpt-4.1-mini";
  if (routing.enabled === false) {
    return {
      level: "fixed",
      model: fallbackModel,
      reasons: ["model_routing_disabled"]
    };
  }

  const cleanText = String(text || "").trim();
  const lower = normalizeRoutingText(cleanText);
  const reasons = [];

  if (imageParts.length) {
    return {
      level: "vision",
      model: routing.visionModel || routing.complexModel || fallbackModel,
      reasons: ["image_attachment"]
    };
  }

  let score = 0;
  if (cleanText.length > (routing.complexMinChars || 900)) {
    score += 3;
    reasons.push("long_prompt");
  } else if (cleanText.length > (routing.standardMinChars || 220)) {
    score += 1;
    reasons.push("medium_prompt");
  }

  const questionMarks = (cleanText.match(/\?/g) || []).length;
  if (questionMarks >= 2) {
    score += 1;
    reasons.push("multiple_questions");
  }

  if (knowledgeMatches.length >= 2) {
    score += 1;
    reasons.push("multiple_knowledge_matches");
  }

  const complexKeywords = routing.complexKeywords || [
    "analiziraj",
    "strategija",
    "uporedi",
    "objasni detaljno",
    "detaljno",
    "plan",
    "problem",
    "greska",
    "greška",
    "kod",
    "integracija",
    "ugovor",
    "reklamacija",
    "pravni",
    "izracunaj",
    "izračunaj"
  ];
  if (complexKeywords.some((keyword) => lower.includes(normalizeRoutingText(keyword)))) {
    score += 2;
    reasons.push("complex_keyword");
  }

  if (score >= 3) {
    return {
      level: "complex",
      model: routing.complexModel || fallbackModel,
      reasons: reasons.length ? reasons : ["complex_score"]
    };
  }

  if (score >= 1) {
    return {
      level: "standard",
      model: routing.standardModel || fallbackModel,
      reasons: reasons.length ? reasons : ["standard_score"]
    };
  }

  return {
    level: "simple",
    model: routing.simpleModel || fallbackModel,
    reasons: ["short_prompt"]
  };
}

async function buildOpenAiImageParts(attachments, config) {
  const maxImages = Number(config.ai.maxImages || 3);
  const imageAttachments = attachments
    .filter((attachment) => isImageAttachment(attachment))
    .slice(0, maxImages);

  const parts = [];
  for (const attachment of imageAttachments) {
    const imageUrl = await fetchImageAsDataUrl(attachment, config);
    if (imageUrl) {
      parts.push({
        type: "input_image",
        image_url: imageUrl
      });
    }
  }
  return parts;
}

export function buildGeminiBody({ text, imageParts = [], config, conversation, knowledgeMatches = [] }) {
  const context = buildKnowledgeContext(knowledgeMatches, config.ai.maxContextChars || 4000);
  const history = buildConversationHistory(conversation, config.ai.maxHistoryChars || 1600);
  const systemInstruction = [
    config.ai.systemPrompt,
    buildCommerceSystemGuidance({ config, catalog: config.catalog || {} }),
    `Ovaj razgovor pripada samo klijentu: ${config.business?.name || "nepoznat klijent"}. Ne koristi informacije, cene, proizvode, politiku ili istoriju drugih klijenata.`,
    "Prepoznaj jezik korisnika iz poslednje poruke i odgovori istim jezikom i istim pismom kada je moguce.",
    "Odgovaraj kratko, prirodno, poslovno i bez sablonskog ponavljanja prethodnih odgovora.",
    "Ako korisnik posalje sliku, opisi samo ono sto je relevantno za korisnicku podrsku i postavi razumno potpitanje kada nije jasno sta zeli.",
    "Ne izmisljaj cene, rokove, politiku povrata, pravne informacije ni status porudzbine.",
    "Ako korisnik pita za proizvod, cenu, dostavu, zamenu, reklamaciju ili rok izrade, koristi iskljucivo pouzdan kontekst, katalog i pravila klijenta.",
    imageParts.length ? buildProductImageCatalog(config.catalog || {}) : "",
    "Ako odgovor nije podrzan pravilima, slikom ili kontekstom, predlozi razgovor sa agentom.",
    history ? `Skorasnji tok razgovora:\n${history}` : "",
    context ? `Pouzdan kontekst iz baze znanja:\n${context}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = String(text || "").trim() || "Korisnik je poslao sliku bez dodatnog teksta. Odgovori na osnovu slike i konteksta razgovora.";

  return {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt.slice(0, config.ai.maxInputChars || 2000) },
          ...imageParts
        ]
      }
    ],
    generationConfig: {
      temperature: config.ai.temperature ?? 0.2,
      maxOutputTokens: config.ai.maxOutputTokens || 500
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
    ]
  };
}

async function buildGeminiImageParts(attachments, config) {
  const maxImages = Number(config.ai.maxImages || 3);
  const imageAttachments = attachments
    .filter((attachment) => isImageAttachment(attachment))
    .slice(0, maxImages);

  const parts = [];
  for (const attachment of imageAttachments) {
    const inlineData = await fetchImageAsInlineData(attachment, config);
    if (inlineData) parts.push({ inlineData });
  }
  return parts;
}

async function fetchImageAsInlineData(attachment, config) {
  const image = await fetchImageBytes(attachment, config);
  return {
    mimeType: image.mimeType,
    data: image.data.toString("base64")
  };
}

async function fetchImageAsDataUrl(attachment, config) {
  const image = await fetchImageBytes(attachment, config);
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

async function fetchImageBytes(attachment, config) {
  const maxBytes = Number(config.ai.maxImageBytes || 5 * 1024 * 1024);
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Image fetch failed ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`Image too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`Image too large: ${arrayBuffer.byteLength} bytes`);
  }

  const mimeType = attachment.mimeType || response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  return {
    mimeType,
    data: Buffer.from(arrayBuffer)
  };
}

function buildKnowledgeContext(matches, maxChars) {
  const parts = matches.map((match, index) => {
    const title = match.title || match.question || match.id || `Izvor ${index + 1}`;
    const body = match.answer || match.content || "";
    return `[${index + 1}] ${title}\n${body}`;
  });
  return parts.join("\n\n").slice(0, maxChars);
}

function buildProductImageCatalog(catalog) {
  const products = (catalog.products || [])
    .filter((product) => product.name || product.image || product.price)
    .slice(0, 40)
    .map((product, index) => [
      `${index + 1}. ${product.name || "Proizvod"}`,
      product.price ? `cena: ${product.price}` : "",
      product.url ? `url: ${product.url}` : "",
      product.image ? `slika: ${product.image}` : ""
    ].filter(Boolean).join(" | "));

  if (!products.length) return "";
  return [
    "Katalog proizvoda za prepoznavanje slika:",
    products.join("\n"),
    "Ako slika korisnika lici na proizvod iz kataloga, navedi naziv i cenu samo ako si dovoljno siguran. Ako nisi siguran, pitaj korisnika koji tacno model/proizvod zeli."
  ].join("\n");
}

function buildConversationHistory(conversation, maxChars) {
  const messages = conversation?.messages || [];
  return messages
    .slice(-8)
    .map((message) => `${message.sender === "bot" ? "Bot" : "Korisnik"}: ${message.body || "[attachment]"}`)
    .join("\n")
    .slice(0, maxChars);
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  const chunks = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractGeminiText(data) {
  const chunks = [];
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function isImageAttachment(attachment) {
  return attachment.type === "image" || String(attachment.mimeType || "").startsWith("image/");
}

function normalizeRoutingText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function supportsTemperature(model) {
  return !String(model || "").startsWith("gpt-5");
}

function stableSafetyIdentifier(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function handoffOrNull(config, reason, matched = null) {
  return config.ai.fallbackToHumanOnError
    ? {
        action: "handoff",
        reply: config.handoff.message,
        confidence: 0.2,
        reason,
        matched
      }
    : null;
}
