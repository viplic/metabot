import { fetchWithTimeout } from "./http.js";

export async function appendRecordToSheet({ config, tenantId, record }) {
  const sheets = config.integrations?.googleSheets;
  if (!sheets?.enabled) return { skipped: true, reason: "sheets_disabled" };

  const webhookUrl = sheets.webhookUrlEnv ? process.env[sheets.webhookUrlEnv] : sheets.webhookUrl;
  if (!webhookUrl) return { skipped: true, reason: "missing_sheets_webhook" };
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/i.test(webhookUrl)) {
    throw new Error("Google Sheet webhook URL mora biti Google Apps Script /exec link, ne obican docs.google.com spreadsheet link.");
  }

  const response = await fetchWithTimeout(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId,
      record,
      row: toSheetRow(record)
    })
  }, Number(sheets.timeoutMs || 10000));

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Google Sheets webhook nije javno dostupan. U Google Apps Script deploy podesite: Execute as: Me i Who has access: Anyone, pa nalepite novi /exec URL."
      );
    }
    throw new Error(`Google Sheets webhook failed ${response.status}: ${text.slice(0, 240)}`);
  }

  return { skipped: false, response: text };
}

function toSheetRow(record) {
  return {
    datum: record.createdAt,
    tip: record.type,
    status: record.status,
    platformUserId: record.platformUserId,
    imePrezime: record.customer?.name || "",
    telefon: record.customer?.phone || "",
    email: record.customer?.email || "",
    ulicaBroj: record.delivery?.street || "",
    grad: record.delivery?.city || "",
    postanskiBroj: record.delivery?.postalCode || "",
    proizvod: record.product?.name || "",
    model: record.product?.model || "",
    boja: record.product?.color || "",
    kolicina: record.product?.quantity || "",
    cena: record.product?.price || "",
    napomena: record.notes || record.complaint?.description || ""
  };
}
