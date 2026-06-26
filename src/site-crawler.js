import * as cheerio from "cheerio";
import { fetchWithTimeout } from "./http.js";

const PRICE_PATTERN = /(?:RSD|rsd|din\.?|€|EUR|\$)\s?[\d.,]+|[\d.,]+\s?(?:RSD|rsd|din\.?|€|EUR|\$)/g;

export async function crawlTenantSite(sourceUrl, options = {}) {
  const url = normalizeUrl(sourceUrl);
  const shopifySnapshot = await fetchShopifyCatalog(url);
  const maxPages = Number(options.maxPages || 8);
  const visited = new Set();
  const queue = [url];
  const pages = [];
  const products = [...(shopifySnapshot.products || [])];
  const hasStructuredProducts = products.length > 0;
  const policies = [];
  let rawText = "";

  while (queue.length && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const page = await fetchPage(currentUrl);
    if (!page) continue;

    pages.push(page);
    rawText += `\n\nURL: ${page.url}\n${page.text}`;
    if (!hasStructuredProducts) products.push(...extractProducts(page));
    policies.push(...extractPolicies(page));

    for (const link of page.links) {
      if (visited.size + queue.length >= maxPages) break;
      if (!visited.has(link) && isSameOrigin(url, link) && looksUseful(link)) queue.push(link);
    }
  }

  return {
    sourceUrl: url,
    pages,
    products: dedupeProducts(products),
    policies: dedupePolicies(policies),
    rawText: rawText.trim().slice(0, 120000)
  };
}

export function catalogToKnowledgeDocuments(snapshot) {
  const docs = [];

  for (const product of snapshot.products || []) {
    docs.push({
      id: `product-${slug(product.name || product.url)}`,
      enabled: true,
      title: product.name || "Proizvod",
      keywords: [product.name, ...(product.price ? [product.price] : [])].filter(Boolean),
      content: [
        `Proizvod: ${product.name || ""}`,
        product.price ? `Cena: ${product.price}` : "",
        product.description ? `Opis: ${product.description}` : "",
        product.url ? `URL: ${product.url}` : "",
        product.image ? `Slika: ${product.image}` : ""
      ].filter(Boolean).join("\n"),
      response: ""
    });
  }

  for (const policy of snapshot.policies || []) {
    docs.push({
      id: `policy-${slug(policy.title)}`,
      enabled: true,
      title: policy.title,
      keywords: policy.keywords,
      content: policy.content,
      response: ""
    });
  }

  if (!docs.length && snapshot.rawText) {
    docs.push({
      id: "site-summary",
      enabled: true,
      title: "Sadrzaj sajta",
      keywords: ["sajt", "ponuda", "informacije"],
      content: snapshot.rawText.slice(0, 12000),
      response: ""
    });
  }

  return docs.slice(0, 120);
}

async function fetchPage(url) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "MetaBotCrawler/1.0 (+https://metabot.local)"
      }
    }, 10000);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, svg").remove();

    const title = cleanText($("title").first().text() || $("h1").first().text());
    const metaDescription = cleanText($('meta[name="description"]').attr("content") || "");
    const text = cleanText($("body").text()).slice(0, 30000);
    const links = $("a[href]")
      .map((_, element) => toAbsoluteUrl($(element).attr("href"), url))
      .get()
      .filter(Boolean);
    const images = $("img[src]")
      .map((_, element) => toAbsoluteUrl($(element).attr("src"), url))
      .get()
      .filter(Boolean);

    return {
      url,
      title,
      metaDescription,
      text,
      html,
      links,
      images
    };
  } catch {
    return null;
  }
}

async function fetchShopifyCatalog(sourceUrl) {
  const productsUrl = new URL("/products.json", sourceUrl);
  productsUrl.searchParams.set("limit", "250");

  try {
    const response = await fetchWithTimeout(productsUrl, {
      headers: {
        "User-Agent": "MetaBotCrawler/1.0 (+https://metabot.local)",
        "Accept": "application/json"
      }
    }, 10000);
    if (!response.ok) return { products: [] };
    const data = await response.json();
    const products = (data.products || [])
      .map((product) => shopifyProductToCatalog(product, sourceUrl))
      .filter((product) => product.name && product.price !== "0.00 BAM" && !looksLikeShopifyOptionProduct(product.name));
    return { products };
  } catch {
    return { products: [] };
  }
}

function shopifyProductToCatalog(product, sourceUrl) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const pricedVariants = variants.filter((variant) => Number(variant.price || 0) > 0);
  const prices = [...new Set(pricedVariants.map((variant) => `${variant.price} BAM`))];
  const variantNames = pricedVariants
    .map((variant) => cleanText(variant.title || ""))
    .filter((title) => title && title.toLowerCase() !== "default title");
  const handle = product.handle || "";
  const url = handle ? new URL(`/products/${handle}`, sourceUrl).toString() : sourceUrl;
  const description = cleanText(String(product.body_html || "").replace(/<[^>]+>/g, " "));

  return {
    name: cleanText(product.title || ""),
    price: prices.length <= 1 ? prices[0] || "" : prices.join(" / "),
    description: [
      description,
      variantNames.length ? `Varijante: ${[...new Set(variantNames)].join(", ")}` : ""
    ].filter(Boolean).join("\n"),
    url,
    image: product.images?.[0]?.src || product.image?.src || ""
  };
}

function looksLikeShopifyOptionProduct(name) {
  return /^(izaberite|tekst$|text$|upload|dodaj|odaberite)\b/i.test(cleanText(name));
}

function extractProducts(page) {
  const $ = cheerio.load(page.html);
  const products = [];
  const jsonLd = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).text())
    .get();

  for (const raw of jsonLd) {
    for (const item of parseJsonLd(raw)) {
      if (!isProductType(item)) continue;
      products.push({
        name: cleanText(item.name || ""),
        price: extractJsonLdPrice(item),
        description: cleanText(item.description || ""),
        url: item.url ? toAbsoluteUrl(item.url, page.url) : page.url,
        image: normalizeJsonLdImage(item.image, page.url)
      });
    }
  }

  const pagePrices = page.text.match(PRICE_PATTERN) || [];
  if (pagePrices.length || /proizvod|product|shop|korpa|cena|price/i.test(page.text)) {
    products.push({
      name: page.title || page.metaDescription || "Proizvod / ponuda",
      price: pagePrices[0] || "",
      description: page.metaDescription || page.text.slice(0, 600),
      url: page.url,
      image: page.images?.[0] || ""
    });
  }

  return products.filter((product) => product.name || product.description);
}

function extractPolicies(page) {
  const lower = page.text.toLowerCase();
  const policies = [];
  const policyMap = [
    { title: "Dostava", keywords: ["dostava", "cena dostave", "postarina", "shipping"] },
    { title: "Rok izrade i slanja", keywords: ["rok", "izrada", "slanje", "koliko dana"] },
    { title: "Zamena i reklamacije", keywords: ["zamena", "reklamacija", "povrat", "refund"] },
    { title: "Placanje", keywords: ["placanje", "plaćanje", "kartica", "pouzecem"] }
  ];

  for (const policy of policyMap) {
    if (policy.keywords.some((keyword) => lower.includes(keyword))) {
      policies.push({
        title: policy.title,
        keywords: policy.keywords,
        content: extractRelevantSentences(page.text, policy.keywords).slice(0, 2500) || page.text.slice(0, 1200)
      });
    }
  }
  return policies;
}

function extractRelevantSentences(text, keywords) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => keywords.some((keyword) => sentence.toLowerCase().includes(keyword)))
    .join(" ");
}

function parseJsonLd(raw) {
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap(flattenJsonLd);
  } catch {
    return [];
  }
}

function flattenJsonLd(item) {
  const graph = item?.["@graph"];
  return graph ? [item, ...graph] : [item];
}

function isProductType(item) {
  const type = item?.["@type"];
  return Array.isArray(type) ? type.includes("Product") : type === "Product";
}

function extractJsonLdPrice(item) {
  const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
  if (!offers) return "";
  const price = offers.price || offers.lowPrice || offers.highPrice || "";
  const currency = offers.priceCurrency || "";
  return [price, currency].filter(Boolean).join(" ");
}

function normalizeJsonLdImage(image, baseUrl) {
  const value = Array.isArray(image) ? image[0] : image?.url || image;
  return value ? toAbsoluteUrl(value, baseUrl) : "";
}

function dedupeProducts(products) {
  const seen = new Set();
  return products.filter((product) => {
    const key = `${product.name}|${product.price}|${product.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupePolicies(policies) {
  const seen = new Set();
  return policies.filter((policy) => {
    const key = policy.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("site_url_required");
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value || String(value).startsWith("data:")) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function isSameOrigin(baseUrl, targetUrl) {
  try {
    return new URL(baseUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}

function looksUseful(url) {
  return /product|proizvod|shop|collections|kolekcij|dostav|delivery|shipping|faq|pitanj|kontakt|reklamac|zamena|return|policy|uslov/i.test(url);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}
