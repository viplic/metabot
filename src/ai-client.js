import crypto from "node:crypto";

export async function askAiFallback({ text, config, conversation, knowledgeMatches = [] }) {
  if (!config.ai.enabled || config.ai.provider !== "openai") return null;

  const apiKey = process.env[config.ai.apiKeyEnv || "OPENAI_API_KEY"];
  if (!apiKey) {
    return handoffOrNull(config, "missing_ai_api_key");
  }

  try {
    const body = buildResponsesBody({ text, config, conversation, knowledgeMatches });
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
      confidence: knowledgeMatches.length ? 0.7 : 0.62,
      reason: knowledgeMatches.length ? "ai_rag_fallback" : "ai_fallback",
      matched: data.model || config.ai.model,
      aiResponseId: data.id || null
    };
  } catch (error) {
    return handoffOrNull(config, "ai_error", error.message);
  }
}

export function buildResponsesBody({ text, config, conversation, knowledgeMatches = [] }) {
  const context = buildKnowledgeContext(knowledgeMatches, config.ai.maxContextChars || 4000);
  const instructions = [
    config.ai.systemPrompt,
    "Odgovaraj jezikom korisnika, kratko i poslovno.",
    "Ne izmisljaj cene, rokove, politiku povrata, pravne informacije ni status porudzbine.",
    "Ako odgovor nije podrzan pravilima ili kontekstom, predlozi razgovor sa agentom.",
    context ? `Pouzdan kontekst iz baze znanja:\n${context}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    model: config.ai.model,
    instructions,
    input: String(text || "").slice(0, config.ai.maxInputChars || 2000),
    store: false,
    max_output_tokens: config.ai.maxOutputTokens || 500,
    temperature: config.ai.temperature ?? 0.2,
    safety_identifier: stableSafetyIdentifier(conversation?.platformUserId || conversation?.id || "unknown")
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
