const ORDER_KEYWORDS = [
  "porucujem",
  "poručujem",
  "narucujem",
  "naručujem",
  "kupujem",
  "kupila bih",
  "kupio bih",
  "uzeo bih",
  "uzela bih",
  "hoću da porucim",
  "hocu da porucim",
  "hoću da poručim",
  "zelim da porucim",
  "želim da poručim",
  "kako da porucim",
  "kako da poručim",
  "saljem podatke",
  "šaljem podatke"
];
const DELIVERY_KEYWORDS = ["dostava", "dostave", "dostavu", "postarina", "poštarina", "shipping", "kurir"];
const LATE_KEYWORDS = ["nije stigla", "nije stiglo", "kasni", "kasnjenje", "posiljka", "pošiljka", "tracking", "gde je", "gdje je", "status porudzbine", "status porudžbine"];
const EXCHANGE_KEYWORDS = ["zamena", "zamenu", "zamenim", "zameniti", "zamjena", "zamjenu", "zamijeniti", "velicina", "veličina", "drugi model", "druga boja"];
const COMPLAINT_KEYWORDS = ["reklamacija", "reklamacije", "reklamaciju", "osteceno", "oštećeno", "ne radi", "problem", "nezadovoljan", "nezadovoljna", "povrat", "refund"];
const PRODUCTION_KEYWORDS = ["koliko dana", "rok", "izrada", "kada saljete", "kada šaljete", "kad stize", "kad stiže"];
const PAYMENT_KEYWORDS = ["placanje", "plaćanje", "placam", "plaćam", "platiti", "placa", "plaća", "kartica", "karticom", "pouzecem", "pouzećem", "kuriru", "gotovina"];
const GIFT_PACKAGING_KEYWORDS = ["poklon kutija", "poklon kutiji", "kutija", "kutiji", "pakovanje", "upakovano", "zapakovano"];

export function analyzeCommerceMessage({ text, attachments = [], conversation = {}, config = {}, catalog = {} }) {
  const cleanText = String(text || "").trim();
  const lower = normalize(cleanText);
  const extracted = extractOrderFields(cleanText, catalog, attachments);
  const intent = detectIntent(lower, extracted);
  const profile = { ...(conversation.profile || {}), ...(extracted.customer || {}) };
  const missingFields = intent === "order" ? missingOrderFields({ ...extracted, customer: profile }, config) : [];

  return {
    intent,
    confidence: scoreIntent(intent, lower, extracted),
    extracted: {
      ...extracted,
      customer: profile
    },
    missingFields,
    shouldRecord:
      intent === "complaint" ||
      intent === "exchange" ||
      intent === "late_shipment" ||
      (intent === "order" && missingFields.length === 0)
  };
}

export function buildCommerceSystemGuidance({ config, catalog }) {
  const sourceUrl = config.catalog?.sourceUrl || catalog?.sourceUrl || "";
  return [
    "Ti si iskusan prodajni asistent za ovaj konkretan shop/brend.",
    "Odgovaraj prirodno, ljudski, smireno i kratko. Najcesce je dovoljna jedna kratka poruka. Ne pominji da si AI, model, sistem ili automatizacija.",
    "Prepoznaj jezik korisnika i odgovori istim jezikom. Ako je korisnik pisao latinicom, odgovori latinicom; ako je pisao cirilicom, odgovori cirilicom.",
    "Koristi samo informacije iz baze znanja, kataloga, sajta i pravilnika ovog klijenta. Ako podatak ne postoji, reci da mozes proveriti ili zamoli korisnika za naziv/opis proizvoda ili sliku.",
    "Ne izmisljaj cene, rokove, stanje posiljke, popuste, dostupnost, garanciju ili pravila zamene.",
    "Ne trazi link od kupca. Ako kupac pita za proizvod, cenu, dostupnost, dostavu ili rok, odgovori normalno na pitanje koristeci katalog/kontekst; ako proizvod nije jasan, trazi naziv proizvoda ili sliku, ne link.",
    "Ne salji linkove ka proizvodima osim ako korisnik izricito trazi link.",
    "Ne trazi boju, model, varijantu, velicinu, adresu ili telefon dok kupac jasno ne kaze da zeli da poruci/kupi.",
    "Tek kada korisnik jasno zeli da poruci, prirodno ga vodi recenicom: \"Ukoliko zelite da porucite, ostavite podatke\" i trazi samo podatke koji fale.",
    "Za porudzbinu prikupi: ime i prezime, ulica i broj, grad, postanski broj, broj telefona, proizvod i kolicinu. Boju/model/varijantu trazi samo ako je taj podatak potreban za taj proizvod ili ga kupac nije naveo.",
    "Za reklamacije i kasnjenje posiljke smiri korisnika, reci da cemo proveriti/resiti situaciju, trazi kontakt i detalje, i ne obecavaj ishod koji nije u pravilima.",
    sourceUrl ? `Primarni izvor istine za shop je: ${sourceUrl}` : ""
  ].filter(Boolean).join("\n");
}

export function formatMissingOrderPrompt(missingFields) {
  const labels = {
    name: "ime i prezime",
    city: "grad",
    postalCode: "poštanski broj",
    street: "adresu i broj",
    phone: "broj telefona",
    product: "proizvod koji zelite"
  };
  const preferredOrder = ["name", "city", "postalCode", "street", "phone", "product"];
  const orderedFields = preferredOrder.filter((field) => missingFields.includes(field))
    .concat(missingFields.filter((field) => !preferredOrder.includes(field)));
  const missing = orderedFields.map((field) => labels[field] || field);
  if (!missing.length) return "";
  return `Može. Za porudžbinu pošaljite ${joinHuman(missing)}.`;
}

function detectIntent(lower, extracted = {}) {
  if (COMPLAINT_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "complaint";
  if (EXCHANGE_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "exchange";
  if (LATE_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "late_shipment";
  if (DELIVERY_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "delivery_price";
  if (PRODUCTION_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "production_time";
  if (PAYMENT_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "payment";
  if (GIFT_PACKAGING_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "gift_packaging";
  if (ORDER_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "order";
  if (looksLikeOrderDetails(extracted)) return "order";
  if (extracted.product?.name && /\b(hocu|hoću|zelim|želim|uzimam|uzecu|uzeću)\s+(ovo|taj|tu|to)\b/.test(lower)) return "order";
  return "question";
}

function looksLikeOrderDetails(extracted = {}) {
  const customer = extracted.customer || {};
  const delivery = extracted.delivery || {};
  const product = extracted.product || {};
  const filled = [
    customer.name,
    customer.phone,
    delivery.street,
    delivery.city,
    delivery.postalCode,
    product.name
  ].filter(Boolean).length;
  return Boolean(customer.phone && filled >= 4);
}

function scoreIntent(intent, lower, extracted) {
  if (intent === "question") return 0.45;
  let score = 0.72;
  if (extracted.customer?.phone) score += 0.08;
  if (extracted.product?.name) score += 0.08;
  if (lower.length > 80) score += 0.04;
  return Math.min(0.95, score);
}

function extractOrderFields(text, catalog, attachments = []) {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.replace(/\s+/g, " ").trim() || "";
  const postalCode = text.match(/\b\d{5}\b/)?.[0] || "";
  const segments = splitOrderSegments(text);
  const city = extractCity(text);
  const name = text.match(/(?:zovem se|ime mi je|ja sam|ime i prezime)[:\s]+([A-Za-zÀ-ž .'’-]{2,50})(?=\n|$|,|;)/i)?.[1]?.trim() ||
    inferCustomerName(segments, { city, postalCode, phone });
  const street = text.match(/(?:ulica|adresa|adresa je|ul\.?)[:\s]+([A-Za-zÀ-ž0-9 .'’/-]{3,80})(?=\n|$|,|;)/i)?.[1]?.trim() ||
    inferStreetAddress(segments, { city, postalCode, phone, name });
  const quantity = Number(text.match(/(?:x|kom|komada|kolicina|količina)\s?(\d{1,3})/i)?.[1] || text.match(/\b(\d{1,3})\s?(?:kom|komada)\b/i)?.[1] || 1);
  const color = text.match(/(?:boja|u boji|color)[:\s]+([A-Za-zÀ-ž\s-]{3,30})/i)?.[1]?.trim() || "";
  const model = text.match(/(?:model|velicina|veličina|size)[:\s]+([A-Za-zÀ-ž0-9\s-]{1,30})/i)?.[1]?.trim() || "";
  const textProduct = findMentionedProduct(text, catalog);
  const imageProduct = findProductFromAttachments(attachments, catalog);
  const product = textProduct || imageProduct?.product || null;

  return {
    customer: {
      name,
      email,
      phone
    },
    delivery: {
      street,
      city,
      postalCode
    },
    product: {
      name: product?.name || "",
      url: product?.url || "",
      price: product?.price || "",
      image: product?.image || "",
      color,
      model,
      quantity,
      matchSource: textProduct ? "text" : imageProduct?.source || "",
      matchConfidence: imageProduct?.confidence || (textProduct ? 0.92 : 0)
    }
  };
}

function splitOrderSegments(text) {
  return String(text || "")
    .split(/[\n,;]+|(?<=[.!?])\s+(?=[A-ZÀ-Ž])/)
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function inferCustomerName(segments, { city = "", postalCode = "", phone = "" } = {}) {
  return segments.find((segment) => {
    const normalized = normalize(segment);
    if (!/^[A-Za-zÀ-ž .'’-]{5,60}$/.test(segment)) return false;
    if (city && normalized.includes(normalize(city))) return false;
    if (postalCode && segment.includes(postalCode)) return false;
    if (phone && segment.includes(phone)) return false;
    if (ORDER_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)))) return false;
    if (DELIVERY_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)))) return false;
    return segment.trim().split(/\s+/).length >= 2;
  }) || "";
}

function inferStreetAddress(segments, { city = "", postalCode = "", phone = "", name = "" } = {}) {
  return segments.find((segment) => {
    const normalized = normalize(segment);
    if (!/\d+[A-Za-z]?\b/.test(segment)) return false;
    if (postalCode && segment.includes(postalCode)) return false;
    if (phone && normalizeDigits(segment) === normalizeDigits(phone)) return false;
    if (city && normalized === normalize(city)) return false;
    if (name && normalized === normalize(name)) return false;
    if (/^\+?\d[\d\s().-]{6,}\d$/.test(segment)) return false;
    return /[A-Za-zÀ-ž]/.test(segment);
  }) || "";
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function extractCity(text) {
  const explicit = text.match(/(?:grad|mesto)[:\s]+([A-Za-zÀ-ž -]{2,40})(?=\n|$|,|;)/i)?.[1]?.trim();
  if (explicit) return explicit;
  const common = [
    "sarajevo",
    "banja luka",
    "tuzla",
    "zenica",
    "mostar",
    "bijeljina",
    "brcko",
    "brčko",
    "prijedor",
    "doboj",
    "trebinje",
    "bihac",
    "bihać",
    "beograd",
    "novi sad",
    "nis",
    "niš",
    "kragujevac",
    "subotica",
    "zrenjanin",
    "leskovac",
    "cacak",
    "čačak"
  ];
  const lower = normalize(text);
  return common.find((city) => lower.includes(normalize(city))) || "";
}

function findMentionedProduct(text, catalog) {
  const lower = normalize(text);
  const queryTokens = new Set(matchTokens(text));
  let best = null;
  for (const product of catalog.products || []) {
    if (!product.name) continue;
    const normalizedName = normalize(product.name);
    if (lower.includes(normalizedName)) return product;

    const productTokens = matchTokens(product.name);
    if (!productTokens.length) continue;
    const hits = productTokens.filter((token) => queryTokens.has(token)).length;
    const score = hits / productTokens.length;
    if (hits >= 2 && score >= 0.45 && (!best || score > best.score)) {
      best = { product, score };
    }
  }
  return best?.product || null;
}

function findProductFromAttachments(attachments = [], catalog = {}) {
  const imageAttachments = attachments.filter((attachment) =>
    attachment.type === "image" || String(attachment.mimeType || "").startsWith("image/")
  );
  if (!imageAttachments.length) return null;

  const products = catalog.products || [];
  for (const attachment of imageAttachments) {
    const attachmentUrl = normalizeUrlForMatch(attachment.url);
    const attachmentFileTokens = urlTokens(attachment.url);
    let best = null;

    for (const product of products) {
      if (!product.image) continue;
      const productUrl = normalizeUrlForMatch(product.image);
      if (attachmentUrl && productUrl && attachmentUrl === productUrl) {
        return { product, source: "image_url", confidence: 0.98 };
      }

      const overlap = tokenOverlap(attachmentFileTokens, urlTokens(product.image));
      if (overlap > 0 && (!best || overlap > best.confidence)) {
        best = { product, source: "image_filename", confidence: Math.min(0.88, 0.55 + overlap) };
      }
    }

    if (best && best.confidence >= 0.72) return best;
  }

  return null;
}

function missingOrderFields(extracted, config) {
  const required = config.orders?.requiredFields || ["name", "city", "postalCode", "street", "phone", "product"];
  const checks = {
    name: extracted.customer?.name,
    phone: extracted.customer?.phone,
    street: extracted.delivery?.street,
    city: extracted.delivery?.city,
    postalCode: extracted.delivery?.postalCode,
    product: extracted.product?.name
  };
  return required.filter((field) => !checks[field]);
}

function joinHuman(values) {
  if (values.length <= 1) return values[0] || "";
  return `${values.slice(0, -1).join(", ")} i ${values.at(-1)}`;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizeUrlForMatch(value) {
  try {
    const url = new URL(String(value || ""));
    url.search = "";
    url.hash = "";
    return url.toString().toLowerCase();
  } catch {
    return "";
  }
}

function urlTokens(value) {
  try {
    const pathname = new URL(String(value || "")).pathname;
    return normalize(pathname)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  } catch {
    return [];
  }
}

function tokenOverlap(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const hits = left.filter((token) => rightSet.has(token)).length;
  return hits / Math.max(left.length, right.length);
}

function matchTokens(value) {
  return normalize(value)
    .split(/[^a-z0-9]+/i)
    .map(stemToken)
    .filter((token) => token.length >= 4 && !PRODUCT_STOP_WORDS.has(token));
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

const PRODUCT_STOP_WORDS = new Set([
  "koja",
  "koji",
  "koje",
  "koliko",
  "cena",
  "cijena",
  "kosta",
  "price",
  "proizvod",
  "personalizovan",
  "personalizovana",
  "slikom",
  "slika"
]);
