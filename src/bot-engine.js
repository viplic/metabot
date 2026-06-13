import { redactValue } from "./security.js";

export async function routeIncomingMessage({ text, config, conversation, channelType = "messenger" }) {
  const now = new Date().toISOString();
  const cleanText = String(text || "").trim().slice(0, 4000);
  const profileUpdates = extractProfile(cleanText);
  conversation.profile = { ...(conversation.profile || {}), ...profileUpdates };
  conversation.lastUserAt = now;

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
    const aiDecision = await askAiFallback(cleanText, config);
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

async function askAiFallback(text, config) {
  if (config.ai.provider !== "openai") return null;

  const apiKey = process.env[config.ai.apiKeyEnv || "OPENAI_API_KEY"];
  if (!apiKey) {
    return config.ai.fallbackToHumanOnError
      ? {
          action: "handoff",
          reply: config.handoff.message,
          confidence: 0.2,
          reason: "missing_ai_api_key"
        }
      : null;
  }

  try {
    const body = {
      model: config.ai.model,
      messages: [
        {
          role: "system",
          content: config.ai.systemPrompt
        },
        {
          role: "user",
          content: text.slice(0, config.ai.maxInputChars)
        }
      ]
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`OpenAI error ${response.status}`);
    }

    const data = await response.json();
    return {
      action: "reply",
      reply: data.choices?.[0]?.message?.content || config.business.defaultReply,
      confidence: 0.62,
      reason: "ai_fallback",
      matched: config.ai.model
    };
  } catch (error) {
    return config.ai.fallbackToHumanOnError
      ? {
          action: "handoff",
          reply: config.handoff.message,
          confidence: 0.2,
          reason: "ai_error",
          matched: error.message
        }
      : null;
  }
}

function handoffDecision(config, reason, matched, profileUpdates) {
  return decision({
    action: config.handoff.enabled ? "handoff" : "fallback",
    reply: config.handoff.enabled ? config.handoff.message : config.business.defaultReply,
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
    profileUpdates: payload.profileUpdates || {}
  };
}

function interpolate(template, context) {
  return String(template || "")
    .replaceAll("{business.name}", context.business.name || "")
    .replaceAll("{channel}", context.channelType || "");
}

export function appendConversationMessages(conversation, incomingText, result, config) {
  const now = new Date().toISOString();
  const redact = Boolean(config.privacy.redactLogs);
  conversation.messages.push({
    sender: "user",
    body: redactValue(incomingText, redact),
    createdAt: now
  });
  conversation.messages.push({
    sender: "bot",
    body: redactValue(result.reply, redact),
    action: result.action,
    confidence: result.confidence,
    reason: result.reason,
    matched: result.matched,
    createdAt: now
  });
  conversation.lastBotAt = now;

  if (result.action === "handoff") {
    conversation.humanHandoff = true;
    conversation.status = "handoff";
  }

  conversation.audit.push({
    actor: "bot",
    action: `message.${result.action}`,
    payload: {
      confidence: result.confidence,
      reason: result.reason,
      matched: result.matched
    },
    createdAt: now
  });
}
