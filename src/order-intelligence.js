const ORDER_KEYWORDS = ["porucujem", "poručujem", "narucujem", "naručujem", "kupujem", "hoću", "hocu", "želim", "zelim", "uzeo bih", "uzela bih"];
const DELIVERY_KEYWORDS = ["dostava", "postarina", "poštarina", "shipping", "kurir"];
const LATE_KEYWORDS = ["nije stigla", "nije stiglo", "kasni", "posiljka", "pošiljka", "tracking", "gde je", "porudzbina", "porudžbina"];
const EXCHANGE_KEYWORDS = ["zamena", "zamenim", "velicina", "veličina", "drugi model", "druga boja"];
const COMPLAINT_KEYWORDS = ["reklamacija", "osteceno", "oštećeno", "ne radi", "problem", "nezadovoljan", "nezadovoljna", "povrat", "refund"];
const PRODUCTION_KEYWORDS = ["koliko dana", "rok", "izrada", "kada saljete", "kada šaljete", "kad stize", "kad stiže"];

export function analyzeCommerceMessage({ text, conversation = {}, config = {}, catalog = {} }) {
  const cleanText = String(text || "").trim();
  const lower = normalize(cleanText);
  const intent = detectIntent(lower);
  const extracted = extractOrderFields(cleanText, catalog);
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
    "Odgovaraj prirodno, ljudski, smireno i kratko. Ne pominji da si AI, model, sistem ili automatizacija.",
    "Koristi samo informacije iz baze znanja, kataloga, sajta i pravilnika ovog klijenta. Ako podatak ne postoji, reci da mozes proveriti ili zamoli korisnika za precizniji model/proizvod.",
    "Ne izmisljaj cene, rokove, stanje posiljke, popuste, dostupnost, garanciju ili pravila zamene.",
    "Ako korisnik zeli da poruci, prirodno ga vodi recenicom: \"Ukoliko zelite da porucite, ostavite podatke\" i trazi samo podatke koji fale.",
    "Za porudzbinu prikupi: ime i prezime, ulica i broj, grad, postanski broj, broj telefona, proizvod/model/boju/varijantu i kolicinu ako je relevantno.",
    "Za reklamacije i kasnjenje posiljke smiri korisnika, reci da cemo proveriti/resiti situaciju, trazi kontakt i detalje, i ne obecavaj ishod koji nije u pravilima.",
    sourceUrl ? `Primarni izvor istine za shop je: ${sourceUrl}` : ""
  ].filter(Boolean).join("\n");
}

export function formatMissingOrderPrompt(missingFields) {
  const labels = {
    name: "ime i prezime",
    phone: "broj telefona",
    street: "ulicu i broj",
    city: "grad",
    postalCode: "postanski broj",
    product: "proizvod/model/boju koju zelite"
  };
  const missing = missingFields.map((field) => labels[field] || field);
  if (!missing.length) return "";
  return `Ukoliko zelite da porucite, ostavite jos: ${joinHuman(missing)}.`;
}

function detectIntent(lower) {
  if (COMPLAINT_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "complaint";
  if (EXCHANGE_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "exchange";
  if (LATE_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "late_shipment";
  if (DELIVERY_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "delivery_price";
  if (PRODUCTION_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "production_time";
  if (ORDER_KEYWORDS.some((keyword) => lower.includes(normalize(keyword)))) return "order";
  return "question";
}

function scoreIntent(intent, lower, extracted) {
  if (intent === "question") return 0.45;
  let score = 0.72;
  if (extracted.customer?.phone) score += 0.08;
  if (extracted.product?.name) score += 0.08;
  if (lower.length > 80) score += 0.04;
  return Math.min(0.95, score);
}

function extractOrderFields(text, catalog) {
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.replace(/\s+/g, " ").trim() || "";
  const postalCode = text.match(/\b\d{5}\b/)?.[0] || "";
  const name = text.match(/(?:zovem se|ime mi je|ja sam|ime i prezime[:\s]+)\s+([A-Za-zÀ-ž\s.'-]{2,50})/i)?.[1]?.trim() || "";
  const street = text.match(/(?:ulica|adresa|adresa je|ul\.?)[:\s]+([A-Za-zÀ-ž0-9\s.'/-]{3,80})/i)?.[1]?.trim() || "";
  const city = extractCity(text);
  const quantity = Number(text.match(/(?:x|kom|komada|kolicina|količina)\s?(\d{1,3})/i)?.[1] || text.match(/\b(\d{1,3})\s?(?:kom|komada)\b/i)?.[1] || 1);
  const color = text.match(/(?:boja|u boji|color)[:\s]+([A-Za-zÀ-ž\s-]{3,30})/i)?.[1]?.trim() || "";
  const model = text.match(/(?:model|velicina|veličina|size)[:\s]+([A-Za-zÀ-ž0-9\s-]{1,30})/i)?.[1]?.trim() || "";
  const product = findMentionedProduct(text, catalog);

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
      color,
      model,
      quantity
    }
  };
}

function extractCity(text) {
  const explicit = text.match(/(?:grad|mesto)[:\s]+([A-Za-zÀ-ž\s-]{2,40})/i)?.[1]?.trim();
  if (explicit) return explicit;
  const common = ["beograd", "novi sad", "nis", "niš", "kragujevac", "subotica", "zrenjanin", "leskovac", "cacak", "čačak"];
  const lower = normalize(text);
  return common.find((city) => lower.includes(normalize(city))) || "";
}

function findMentionedProduct(text, catalog) {
  const lower = normalize(text);
  return (catalog.products || []).find((product) => product.name && lower.includes(normalize(product.name))) || null;
}

function missingOrderFields(extracted, config) {
  const required = config.orders?.requiredFields || ["name", "phone", "street", "city", "postalCode", "product"];
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
