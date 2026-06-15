export function retrieveKnowledge(text, config) {
  if (!config.knowledge?.enabled) return [];

  const queryTokens = tokenize(text);
  if (!queryTokens.length) return [];

  const candidates = [
    ...faqCandidates(config.automation?.faqs || []),
    ...documentCandidates(config.knowledge.documents || [])
  ];

  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(queryTokens, candidate) }))
    .filter((candidate) => candidate.score >= (config.knowledge.minScore || 0.35))
    .sort((left, right) => right.score - left.score)
    .slice(0, config.knowledge.maxMatches || 4);
}

export function shouldAutoReplyFromKnowledge(match, config) {
  return Boolean(match && match.score >= (config.knowledge?.autoReplyThreshold || 0.82));
}

function faqCandidates(faqs) {
  return faqs
    .filter((faq) => faq.enabled && faq.answer)
    .map((faq) => ({
      id: faq.id,
      type: "faq",
      title: faq.question,
      question: faq.question,
      keywords: faq.keywords || [],
      answer: faq.answer,
      content: faq.answer
    }));
}

function documentCandidates(documents) {
  return documents
    .filter((document) => document.enabled && document.content)
    .map((document) => ({
      id: document.id,
      type: "document",
      title: document.title,
      keywords: document.keywords || [],
      answer: document.response || document.content,
      content: document.content
    }));
}

function scoreCandidate(queryTokens, candidate) {
  const haystack = [
    candidate.title,
    candidate.question,
    candidate.keywords?.join(" "),
    candidate.content,
    candidate.answer
  ].join(" ");
  const candidateTokens = new Set(tokenize(haystack));
  if (!candidateTokens.size) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }

  const keywordBoost = (candidate.keywords || []).some((keyword) =>
    normalize(haystackFromTokens(queryTokens)).includes(normalize(keyword))
  )
    ? 0.25
    : 0;
  const coverage = hits / queryTokens.length;
  return Number(Math.min(1, coverage + keywordBoost).toFixed(3));
}

function haystackFromTokens(tokens) {
  return tokens.join(" ");
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

const STOP_WORDS = new Set([
  "kako",
  "koji",
  "koja",
  "koje",
  "sta",
  "sto",
  "sam",
  "ste",
  "smo",
  "sve",
  "the",
  "and",
  "for",
  "with"
]);
