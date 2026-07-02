import { redactValue } from "./security.js";
import { askAiFallback } from "./ai-client.js";
import { retrieveKnowledge, shouldAutoReplyFromKnowledge } from "./knowledge.js";
import { analyzeCommerceMessage, formatMissingOrderPrompt } from "./order-intelligence.js";

export async function routeIncomingMessage({
  text,
  attachments = [],
  config,
  conversation,
  channelType = "messenger",
  eventTimestamp = Date.now()
}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const eventDate = resolveEventDate(eventTimestamp, now);
  const eventIso = eventDate.toISOString();
  const cleanText = String(text || "").trim().slice(0, 4000);
  const profileUpdates = extractProfile(cleanText);
  conversation.profile = { ...(conversation.profile || {}), ...profileUpdates };
  conversation.lastUserAt = eventIso;
  conversation.lastReceivedAt = nowIso;

  const policyDecision = checkMessagingPolicy(config, eventDate, now);
  if (policyDecision === "outside_human_agent_window") {
    return decision({
      action: "policy_expired",
      reply: "",
      sendAllowed: false,
      confidence: 1,
      reason: "outside_human_agent_window",
      profileUpdates
    });
  }

  if (policyDecision === "outside_policy_window") {
    return decision({
      action: config.handoff.enabled ? "handoff" : "policy_blocked",
      reply: "",
      sendAllowed: false,
      confidence: 1,
      reason: "outside_policy_window",
      profileUpdates
    });
  }

  if (!config.automation.enabled) {
    return decision({
      action: "disabled",
      reply: config.business.defaultReply,
      confidence: 1,
      reason: "automation_disabled",
      profileUpdates
    });
  }

  const lower = normalizeText(cleanText);
  const handoffKeyword = findKeyword(lower, config.automation.handoffKeywords);
  if (handoffKeyword) {
    return handoffDecision(config, "handoff_keyword", handoffKeyword, profileUpdates);
  }

  const riskyKeyword = findKeyword(lower, config.automation.riskyKeywords);
  if (riskyKeyword) {
    return handoffDecision(config, "risky_keyword", riskyKeyword, profileUpdates);
  }

  const commerce = analyzeCommerceMessage({
    text: cleanText,
    attachments,
    conversation,
    config,
    catalog: config.catalog || {}
  });

  if (commerce.intent === "order" && commerce.missingFields.length) {
    return decision({
      action: "collect_order_data",
      reply: formatMissingOrderPrompt(commerce.missingFields),
      confidence: commerce.confidence,
      reason: "missing_order_fields",
      matched: commerce.missingFields.join(","),
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "order" && !commerce.missingFields.length) {
    return decision({
      action: "reply",
      reply: "Super, zabeležili smo porudžbinu. Javljamo se uskoro za potvrdu.",
      confidence: commerce.confidence,
      reason: "order_complete",
      matched: commerce.extracted?.product?.name || "order",
      profileUpdates,
      commerce
    });
  }

  if (commerce.extracted?.product?.name && isPriceQuestion(cleanText) && commerce.extracted.product.price) {
    return decision({
      action: "reply",
      reply: formatProductPriceReply(commerce.extracted.product, config),
      confidence: commerce.extracted.product.matchConfidence || 0.86,
      reason: hasImageAttachment(attachments) ? "image_product_price" : "product_price",
      matched: commerce.extracted.product.name,
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "late_shipment") {
    return decision({
      action: "reply",
      reply: "Razumem. Pošaljite broj telefona ili porudžbine da proverimo gde je pošiljka.",
      confidence: commerce.confidence,
      reason: "late_shipment",
      matched: "shipment_status",
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "delivery_price") {
    return decision({
      action: "reply",
      reply: formatDeliveryReply(config),
      confidence: commerce.confidence,
      reason: "delivery_price",
      matched: "delivery",
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "production_time") {
    return decision({
      action: "reply",
      reply: formatProductionTimeReply(config),
      confidence: commerce.confidence,
      reason: "production_time",
      matched: "production_time",
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "payment") {
    return decision({
      action: "reply",
      reply: config.business.paymentReply || "Plaćanje je pouzećem, kuriru pri dostavi. Ako želite da poručite, ostavite nam vaše podatke.",
      confidence: commerce.confidence,
      reason: "payment",
      matched: "payment",
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "exchange") {
    return decision({
      action: "reply",
      reply: config.business.exchangeReply || "Može, samo nam pošaljite broj porudžbine ili telefon, pa ćemo proveriti zamenu.",
      confidence: commerce.confidence,
      reason: "exchange",
      matched: "exchange",
      profileUpdates,
      commerce
    });
  }

  if (commerce.intent === "complaint") {
    return decision({
      action: "reply",
      reply: config.business.complaintReply || "Žao mi je zbog toga. Pošaljite sliku problema i telefon, rešićemo reklamaciju.",
      confidence: commerce.confidence,
      reason: "complaint",
      matched: "complaint",
      profileUpdates,
      commerce
    });
  }

  const knowledgeMatches = retrieveKnowledge(cleanText, config);
  if (shouldAutoReplyFromKnowledge(knowledgeMatches[0], config)) {
    return decision({
      action: "reply",
      reply: appendSalesCtaIfPriceAnswer(
        interpolate(knowledgeMatches[0].answer, { business: config.business, channelType }),
        config
      ),
      confidence: knowledgeMatches[0].score,
      reason: "knowledge",
      matched: knowledgeMatches[0].title,
      profileUpdates
    });
  }

  const ruleMatch = findBestRule(lower, config.automation.rules);
  if (ruleMatch) {
    return decision({
      action: "reply",
      reply: interpolate(ruleMatch.rule.response, { business: config.business, channelType }),
      confidence: ruleMatch.confidence,
      reason: "rule",
      matched: ruleMatch.rule.name,
      profileUpdates
    });
  }

  const faqMatch = findBestFaq(lower, config.automation.faqs);
  if (faqMatch && faqMatch.confidence >= config.automation.confidenceThreshold) {
    return decision({
      action: "reply",
      reply: interpolate(faqMatch.faq.answer, { business: config.business, channelType }),
      confidence: faqMatch.confidence,
      reason: "faq",
      matched: faqMatch.faq.question,
      profileUpdates
    });
  }

  const missingField = nextMissingField(config, conversation);
  if (missingField) {
    return decision({
      action: "collect_data",
      reply: config.automation.leadCapturePrompt.replace("{field}", missingField.label),
      confidence: 0.7,
      reason: "missing_profile_field",
      matched: missingField.id,
      profileUpdates
    });
  }

  if (config.ai.enabled) {
    const aiDecision = await askAiFallback({
      text: cleanText,
      attachments,
      config,
      conversation,
      knowledgeMatches
    });
    if (aiDecision) {
      return decision({ ...aiDecision, profileUpdates });
    }
  }

  return decision({
    action: "fallback",
    reply: config.business.defaultReply,
    confidence: 0.4,
    reason: "default_reply",
    profileUpdates
  });
}

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function findBestRule(normalizedText, rules) {
  let best = null;

  for (const rule of rules.filter((item) => item.enabled)) {
    const keyword = findKeyword(normalizedText, rule.keywords);
    if (!keyword) continue;
    const confidence = Number(rule.confidence || 0.9);
    if (!best || confidence > best.confidence) {
      best = { rule, confidence, keyword };
    }
  }

  return best;
}

function findBestFaq(normalizedText, faqs) {
  let best = null;

  for (const faq of faqs.filter((item) => item.enabled)) {
    const keyword = findKeyword(normalizedText, faq.keywords);
    if (!keyword) continue;
    const confidence = scoreKeywordMatch(normalizedText, keyword);
    if (!best || confidence > best.confidence) {
      best = { faq, confidence, keyword };
    }
  }

  return best;
}

function findKeyword(normalizedText, keywords = []) {
  return keywords
    .map((keyword) => normalizeText(keyword))
    .filter(Boolean)
    .find((keyword) => normalizedText.includes(keyword));
}

function scoreKeywordMatch(normalizedText, keyword) {
  if (!keyword) return 0;
  if (normalizedText === keyword) return 1;
  const ratio = Math.min(1, keyword.length / Math.max(normalizedText.length, 1));
  return Math.max(0.74, Number((0.72 + ratio * 0.25).toFixed(2)));
}

function nextMissingField(config, conversation) {
  const profile = conversation.profile || {};
  return config.automation.collectFields.find((field) => field.enabled && field.required && !profile[field.id]);
}

function extractProfile(text) {
  const updates = {};
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0];
  const name = text.match(/(?:zovem se|ime mi je|ja sam)\s+([A-Za-zÀ-ž\s.'-]{2,40})/i)?.[1]?.trim();

  if (email) updates.email = email;
  if (phone) updates.phone = phone.replace(/\s+/g, " ").trim();
  if (name) updates.name = name;
  if (text.length > 3 && !updates.topic) updates.topic = text.slice(0, 160);

  return updates;
}

function handoffDecision(config, reason, matched, profileUpdates) {
  return decision({
    action: config.handoff.enabled ? "handoff" : "fallback",
    reply: config.handoff.enabled ? config.handoff.message : config.business.defaultReply,
    sendAllowed: true,
    confidence: 1,
    reason,
    matched,
    profileUpdates
  });
}

function decision(payload) {
  return {
    reply: payload.reply,
    action: payload.action,
    confidence: payload.confidence,
    reason: payload.reason,
    matched: payload.matched || null,
    modelRouting: payload.modelRouting || null,
    commerce: payload.commerce || null,
    profileUpdates: payload.profileUpdates || {},
    sendAllowed: payload.sendAllowed !== false,
    aiResponseId: payload.aiResponseId || null
  };
}

function hasImageAttachment(attachments = []) {
  return attachments.some((attachment) => attachment.type === "image" || String(attachment.mimeType || "").startsWith("image/"));
}

function isPriceQuestion(text) {
  return /\b(koliko|cena|cijena|kosta|košta|price)\b/i.test(normalizeText(text));
}

function formatProductPriceReply(product = {}, config = {}) {
  const cta = config.business?.salesCta ? ` ${config.business.salesCta}` : "";
  if (product.name && product.price) return `${product.name} košta ${humanPrice(product.price)}.${cta}`;
  if (product.name) return `To je ${product.name}. Cenu možemo proveriti odmah.`;
  return "Možete mi poslati naziv proizvoda ili još jednu jasniju sliku?";
}

function appendSalesCtaIfPriceAnswer(reply, config = {}) {
  const cta = String(config.business?.salesCta || "").trim();
  if (!cta || !mentionsPrice(reply)) return reply;
  if (normalizeText(reply).includes(normalizeText(cta).slice(0, 24))) return reply;
  return `${String(reply || "").trim()} ${cta}`.trim();
}

function mentionsPrice(value) {
  return /(?:\b\d+(?:[.,]\d{1,2})?\s*(?:km|bam|rsd|eur|€|\$)\b|\b(?:km|bam|rsd|eur)\s*\d+(?:[.,]\d{1,2})?)/i.test(String(value || ""));
}

function formatDeliveryReply(config = {}) {
  const reply = config.business?.deliveryReply || "";
  if (reply) return reply;
  const cta = config.business?.salesCta ? ` ${config.business.salesCta}` : "";
  return `Dostavu možemo proveriti odmah.${cta}`.trim();
}

function formatProductionTimeReply(config = {}) {
  const reply = config.business?.productionTimeReply || "";
  if (reply) return reply;
  const cta = config.business?.salesCta ? ` ${config.business.salesCta}` : "";
  return `Rok izrade i isporuke možemo proveriti odmah.${cta}`.trim();
}

function humanPrice(value) {
  return String(value || "").replace(/(\d+)\.(\d{2})\s*BAM\b/i, "$1,$2 KM");
}

function interpolate(template, context) {
  return String(template || "")
    .replaceAll("{business.name}", context.business.name || "")
    .replaceAll("{channel}", context.channelType || "");
}

export function appendConversationMessages(conversation, incomingText, result, config, attachments = []) {
  const now = new Date().toISOString();
  const redact = Boolean(config.privacy.redactLogs);
  const incomingMessage = {
    sender: "user",
    body: redactValue(incomingText, redact),
    createdAt: now
  };

  if (attachments.length) {
    incomingMessage.attachments = attachments.map((attachment) => ({
      type: attachment.type,
      mimeType: attachment.mimeType || "",
      url: redact ? "[redacted]" : attachment.url
    }));
  }

  conversation.messages.push(incomingMessage);

  if (result.sendAllowed !== false && result.reply) {
    conversation.messages.push({
      sender: "bot",
      body: redactValue(result.reply, redact),
      action: result.action,
      confidence: result.confidence,
      reason: result.reason,
      matched: result.matched,
      modelRouting: result.modelRouting,
      commerce: result.commerce,
      aiResponseId: result.aiResponseId,
      createdAt: now
    });
    conversation.lastBotAt = now;
  }

  if (result.action === "handoff") {
    conversation.humanHandoff = true;
    conversation.status = "handoff";
  } else if (result.action === "policy_expired") {
    conversation.status = "policy_expired";
  }

  conversation.audit.push({
    actor: "bot",
    action: `message.${result.action}`,
    payload: {
      confidence: result.confidence,
      reason: result.reason,
      matched: result.matched,
      modelRouting: result.modelRouting,
      commerce: result.commerce,
      aiResponseId: result.aiResponseId,
      sendAllowed: result.sendAllowed !== false
    },
    createdAt: now
  });
}

function checkMessagingPolicy(config, eventDate, now) {
  const policyHours = Number(config.automation?.policyWindowHours || 24);
  const humanDays = Number(config.automation?.humanAgentWindowDays || 7);
  const eventAgeMs = now.getTime() - eventDate.getTime();

  if (eventAgeMs < 0 || policyHours <= 0) return "inside_policy_window";
  if (eventAgeMs <= policyHours * 60 * 60 * 1000) return "inside_policy_window";
  if (humanDays > 0 && eventAgeMs <= humanDays * 24 * 60 * 60 * 1000) {
    return "outside_policy_window";
  }
  return "outside_human_agent_window";
}

function resolveEventDate(value, fallbackDate) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return fallbackDate;
}
