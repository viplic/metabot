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
      answer: document.response || conciseDocumentAnswer(document),
      content: document.content
    }));
}

function conciseDocumentAnswer(document) {
  const content = String(document.content || "");
  const product = content.match(/(?:^|\n)Proizvod:\s*([^\n]+)/i)?.[1]?.trim() || document.title || "";
  const price = content.match(/(?:^|\n)C(?:e|ij)na:\s*([^\n]+)/i)?.[1]?.trim() || "";
  if (String(document.id || "").startsWith("product-") || /^Proizvod:/i.test(content)) {
    return price ? `${product} košta ${humanPrice(price)}.` : `Da, imamo ${product}.`;
  }

  return content
    .split(/\n+/)
    .filter((line) => !/^\s*(URL|Slika):/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 220)
    .trim();
}

function humanPrice(value) {
  return String(value || "").replace(/(\d+)\.(\d{2})\s*BAM\b/i, "$1,$2 KM");
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
    .map(stemToken)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function stemToken(token) {
  let text = String(token || "");
  for (const suffix of ["ovima", "evima", "anje", "enje", "ima", "ama", "om", "em", "og", "oj", "ih", "a", "u", "e", "i"]) {
    if (text.length - suffix.length >= 4 && text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
      break;
    }
  }
  return text;
}

const STOP_WORDS = new Set([
  "kako",
  "koliko",
  "kosta",
  "košta",
  "cena",
  "cijena",
  "cenu",
  "cijenu",
  "ovo",
  "ovaj",
  "ova",
  "taj",
  "tu",
  "to",
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
