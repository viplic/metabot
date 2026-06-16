let session = loadSession();
let tenant = null;
let config = null;
let conversations = [];
let store = null;
let dirty = false;
const bindQueue = [];

const panels = {
  login: document.querySelector("#tab-login"),
  dashboard: document.querySelector("#tab-dashboard"),
  business: document.querySelector("#tab-business"),
  channels: document.querySelector("#tab-channels"),
  knowledge: document.querySelector("#tab-knowledge")
};

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});
document.querySelector("#saveButton").addEventListener("click", save);
document.querySelector("#logoutButton").addEventListener("click", () => {
  localStorage.removeItem("metabot-client-session");
  session = null;
  tenant = null;
  config = null;
  conversations = [];
  renderAll();
  activateTab("login");
  setSaved("Odjavljen", false);
});

await boot();

async function boot() {
  renderLogin();
  if (session?.tenantId && session?.token) {
    try {
      await loadPortal();
      activateTab("dashboard");
      setSaved("Učitano", true);
    } catch {
      localStorage.removeItem("metabot-client-session");
      session = null;
      setSaved("Login istekao", false, true);
    }
  }
}

async function loadPortal() {
  const me = await clientFetch("/client-api/me");
  tenant = me.tenant;
  config = normalizeClientConfig(await clientFetch("/client-api/config"));
  conversations = await clientFetch("/client-api/conversations");
  store = await clientFetch("/client-api/store");
  renderAll();
}

function normalizeClientConfig(value) {
  const normalized = structuredClone(value || {});
  normalized.business ||= {};
  normalized.meta ||= {};
  normalized.channels ||= [];
  normalized.knowledge ||= {};
  normalized.knowledge.documents ||= [];
  normalized.ai ||= {};
  normalized.ai.modelRouting ||= {};
  normalized.catalog ||= {};
  normalized.catalog.sourceUrl ||= "";
  normalized.catalog.refreshEveryHours ||= 24;
  normalized.catalog.autoRefreshEnabled ??= true;
  normalized.usage ||= {};
  normalized.usage.monthlyLimitUsd ||= 20;
  normalized.integrations ||= {};
  normalized.integrations.googleSheets ||= {};
  normalized.integrations.googleSheets.webhookUrlEnv ||= "";
  normalized.integrations.googleSheets.webhookUrl ||= "";
  normalized.integrations.googleSheets.sheetUrl ||= "";
  return normalized;
}

function renderAll() {
  renderLogin();
  if (!config) {
    renderLocked();
    renderSidebar();
    return;
  }
  document.querySelector("#portalTitle").textContent = `${tenant.name} automatizacija`;
  renderDashboard();
  renderBusiness();
  renderChannels();
  renderKnowledge();
  renderSidebar();
}

function renderLogin() {
  const urlTenant = new URLSearchParams(window.location.search).get("tenant") || session?.tenantId || "";
  panels.login.innerHTML = section(
    "Login za klijenta",
    `<form id="loginForm" class="grid">
      <div class="field">
        <label for="tenantId">Klijent ID</label>
        <input id="tenantId" name="tenantId" value="${escapeAttr(urlTenant)}" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" />
      </div>
      <div class="actions full"><button class="primary">Uloguj se</button></div>
    </form>`
  );
  panels.login.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await fetchJson("/client-api/login", {
        method: "POST",
        body: JSON.stringify({
          tenantId: form.get("tenantId"),
          password: form.get("password")
        })
      });
      session = { tenantId: result.tenant.id, token: result.token };
      localStorage.setItem("metabot-client-session", JSON.stringify(session));
      await loadPortal();
      activateTab("dashboard");
      setSaved("Ulogovan", true);
    } catch {
      setSaved("Pogrešan login", false, true);
    }
  });
}

function renderDashboard() {
  const metrics = portalMetrics();
  panels.dashboard.innerHTML = `
    <section class="client-focus-hero" style="--client-color: ${escapeAttr(tenant.color || "#10b981")}; --usage: ${Math.min(100, metrics.botRepliesToday * 5)}%">
      <div class="client-orbit">${metrics.botRepliesToday}</div>
      <div>
        <p class="eyebrow">Klijentski dashboard</p>
        <h2>${escapeHtml(tenant.name)}</h2>
        <p>Ovde vidite samo brojeve i statuse. Sadrzaj razgovora nije prikazan u klijentskom portalu.</p>
      </div>
      <div class="master-usage">
        <span>Status automatizacije</span>
        <strong>${config.automation?.enabled !== false ? "Aktivan" : "Pauziran"}</strong>
        <small>${metrics.activeChannels} aktivna kanala</small>
      </div>
    </section>
    <section class="stat-grid">
      ${statCard("Poruke danas", metrics.messagesToday, "Ukupno registrovano")}
      ${statCard("AI odgovori", metrics.botRepliesToday, "Bez prikaza teksta")}
      ${statCard("Narudzbine", metrics.orders, "Poslate u Google Sheet kada je povezan")}
      ${statCard("Reklamacije", metrics.complaints, "Zamene, kasnjenja i problemi")}
      ${statCard("Handoff", metrics.handoffs, "Treba ljudska provera")}
      ${statCard("Znanje", config.knowledge?.documents?.length || 0, "Dokumenti koje mozete menjati")}
      ${statCard("Proizvodi", store?.catalog?.products?.length || 0, "Ucitan katalog")}
      ${statCard("Kanali", metrics.activeChannels, "Instagram/Facebook")}
    </section>
    ${section(
      "Google Sheet i podaci",
      `<div class="test-result">
        <span>Google Sheet: ${config.integrations?.googleSheets?.enabled ? "ukljucen" : "nije ukljucen"}</span>
        <span>Sheet URL: ${escapeHtml(config.integrations?.googleSheets?.sheetUrl || "nije dodat")}</span>
        <span>Razgovori se cuvaju 30 dana, a narudzbine ostaju sacuvane.</span>
      </div>`
    )}
  `;
}

function renderLocked() {
  for (const [name, panel] of Object.entries(panels)) {
    if (name === "login") continue;
    panel.innerHTML = section("Zaključano", "<p>Ulogujte se da biste videli podešavanja.</p>");
  }
}

function renderBusiness() {
  config.catalog ||= {};
  config.integrations ||= {};
  config.integrations.googleSheets ||= {};
  config.usage ||= {};
  panels.business.innerHTML = section(
    "Niche i poslovni podaci",
    `<div class="grid">
      ${textField("Naziv", config.business.name, (value) => (config.business.name = value))}
      ${textField("Jezik", config.business.language, (value) => (config.business.language = value))}
      ${textField("Vremenska zona", config.business.timezone, (value) => (config.business.timezone = value))}
      ${textArea("Opis niše i ponude", config.business.shortDescription, (value) => (config.business.shortDescription = value), "full")}
      ${textArea("Podrazumevani odgovor", config.business.defaultReply, (value) => (config.business.defaultReply = value), "full")}
      ${textField("Privacy URL", config.business.privacyNoticeUrl, (value) => (config.business.privacyNoticeUrl = value))}
      ${textField("Data deletion URL", config.business.dataDeletionUrl, (value) => (config.business.dataDeletionUrl = value))}
      ${textField("URL sajta / shopa", config.catalog.sourceUrl, (value) => (config.catalog.sourceUrl = value), "full")}
      ${numberField("Osvezavanje sajta na sati", config.catalog.refreshEveryHours, (value) => (config.catalog.refreshEveryHours = Number(value)))}
      ${checkboxField("Automatski osvezavaj sajt", config.catalog.autoRefreshEnabled, (value) => (config.catalog.autoRefreshEnabled = value))}
      ${checkboxField("Google Sheet ukljucen", config.integrations.googleSheets.enabled, (value) => (config.integrations.googleSheets.enabled = value))}
      ${textField("Google Sheet URL", config.integrations.googleSheets.sheetUrl, (value) => (config.integrations.googleSheets.sheetUrl = value), "full")}
      ${textField("Google Sheet webhook URL", config.integrations.googleSheets.webhookUrl, (value) => (config.integrations.googleSheets.webhookUrl = value), "full")}
    </div>`
  );
  panels.business.insertAdjacentHTML(
    "beforeend",
    section(
      "Sinhronizacija sajta",
      `<div class="actions">
        <button id="syncSite" class="primary">Ucitaj proizvode i pravila sa sajta</button>
      </div>
      <div class="test-result">
        <span>Poslednje osvezavanje: ${escapeHtml(config.catalog.lastRefreshAt || "nije pokrenuto")}</span>
        <span>Proizvodi: ${store?.catalog?.products?.length || 0} | Pravila: ${store?.catalog?.policies?.length || 0}</span>
      </div>`
    )
  );
  bindInputs(panels.business);
  panels.business.querySelector("#syncSite").addEventListener("click", async () => {
    setSaved("Ucitavam sajt...", false);
    const result = await clientFetch("/client-api/sync-site", {
      method: "POST",
      body: JSON.stringify({ sourceUrl: config.catalog.sourceUrl })
    });
    config = result.config;
    store = await clientFetch("/client-api/store");
    setSaved(`Ucitan sajt: ${result.products} proizvoda`, true);
    renderAll();
  });
}

function renderChannels() {
  panels.channels.innerHTML = section(
    "Meta profili",
    `<div class="collection">${config.channels.map(channelItem).join("") || `<div class="empty-state">Admin jos nije povezao kanale.</div>`}</div>
    <div class="field full">
      <label>Webhook URL za ovaj portal</label>
      <input readonly value="${escapeAttr(`${window.location.origin}/webhook/${tenant.id}`)}" />
    </div>`
  );
}

function channelItem(channel) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(channel.name)}</h3>
      <span class="pill">${channel.enabled ? "aktivan" : "pauziran"}</span>
    </div>
    <div class="grid three">
      <div class="test-result"><span>Tip: ${escapeHtml(channel.type)}</span></div>
      <div class="test-result"><span>Slanje: ${channel.sendEnabled ? "ukljuceno" : "nije ukljuceno"}</span></div>
      <div class="test-result"><span>Admin podesava Page/IG tokene.</span></div>
    </div>
  </article>`;
}

function renderKnowledge() {
  panels.knowledge.innerHTML = section(
    "Odgovori i baza znanja",
    `<div class="grid three">
      ${checkboxField("Baza znanja uključena", config.knowledge.enabled, (value) => (config.knowledge.enabled = value))}
      ${numberField("Auto odgovor skor", config.knowledge.autoReplyThreshold, (value) => (config.knowledge.autoReplyThreshold = Number(value)), 0, 1, 0.01)}
      ${numberField("Max izvora", config.knowledge.maxMatches, (value) => (config.knowledge.maxMatches = Number(value)))}
    </div>
    <div class="collection">${config.knowledge.documents.map(knowledgeItem).join("")}</div>
    <div class="actions"><button id="addKnowledge">Dodaj dokument</button></div>`
  );
  bindInputs(panels.knowledge);
  panels.knowledge.querySelector("#addKnowledge").addEventListener("click", () => {
    config.knowledge.documents.push({
      id: `knowledge-${Date.now()}`,
      enabled: true,
      title: "Novi dokument",
      keywords: ["ključna reč"],
      content: "Sadržaj",
      response: ""
    });
    markDirty();
    renderKnowledge();
  });
  panels.knowledge.querySelectorAll("[data-remove-knowledge]").forEach((button) => {
    button.addEventListener("click", () => {
      config.knowledge.documents = config.knowledge.documents.filter((doc) => doc.id !== button.dataset.removeKnowledge);
      markDirty();
      renderKnowledge();
    });
  });
}

function knowledgeItem(document) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(document.title)}</h3>
      <button class="danger" data-remove-knowledge="${escapeAttr(document.id)}">Ukloni</button>
    </div>
    <div class="grid">
      ${checkboxField("Aktivno", document.enabled, (value) => (document.enabled = value))}
      ${textField("Naslov", document.title, (value) => (document.title = value))}
      ${textField("Ključne reči", document.keywords.join(", "), (value) => (document.keywords = splitCsv(value)), "full")}
      ${textArea("Sadržaj", document.content, (value) => (document.content = value), "full")}
      ${textArea("Direktan odgovor", document.response, (value) => (document.response = value), "full")}
    </div>
  </article>`;
}

function renderSidebar() {
  const metrics = portalMetrics();
  document.querySelector("#statusList").innerHTML = tenant
    ? `<dt>Klijent</dt><dd>${escapeHtml(tenant.id)}</dd>
      <dt>Profili</dt><dd>${config?.channels?.filter((channel) => channel.enabled).length || 0}</dd>
      <dt>AI</dt><dd>${config?.ai?.enabled ? "on" : "off"}</dd>
      <dt>Odgovori danas</dt><dd>${metrics.botRepliesToday}</dd>
      <dt>Narudzbine</dt><dd>${metrics.orders}</dd>
      <dt>Reklamacije</dt><dd>${metrics.complaints}</dd>
      <dt>Webhook</dt><dd>${escapeHtml(`${window.location.origin}/webhook/${tenant.id}`)}</dd>`
    : `<dt>Status</dt><dd>Nije ulogovan</dd>`;

  document.querySelector("#conversationList").innerHTML =
    [
      ...(store?.orders || []).slice(0, 5).map((order) => ({
        channelType: order.type,
        status: order.status,
        platformUserId: order.customer?.phone || order.platformUserId || "narudzbina"
      }))
    ]
      .slice(0, 12)
      .map((conversation) => `<article class="conversation">
          <strong>${escapeHtml(conversation.channelType)} · ${escapeHtml(conversation.status)}</strong>
          <span>${escapeHtml(conversation.platformUserId)}</span>
          <span>Sadrzaj poruka nije prikazan.</span>
        </article>`)
      .join("") || `<span class="conversation">Nema aktivnosti</span>`;
}

function portalMetrics() {
  const today = new Date().toISOString().slice(0, 10);
  const messagesToday = conversations.reduce((sum, conversation) => {
    return sum + (conversation.messages || []).filter((message) => String(message.createdAt || "").startsWith(today)).length;
  }, 0);
  const botRepliesToday = conversations.reduce((sum, conversation) => {
    return sum + (conversation.messages || []).filter((message) => {
      const sender = message.sender || message.actor || message.role || "";
      return String(message.createdAt || "").startsWith(today) && /bot|assistant|ai/i.test(String(sender));
    }).length;
  }, 0);
  const orders = (store?.orders || []).filter((order) => order.type === "order").length;
  const complaints = (store?.orders || []).filter((order) => order.type && order.type !== "order").length;
  return {
    messagesToday,
    botRepliesToday,
    orders,
    complaints,
    handoffs: conversations.filter((conversation) => conversation.status === "handoff").length,
    activeChannels: config?.channels?.filter((channel) => channel.enabled).length || 0
  };
}

function statCard(label, value, hint) {
  return `<article class="stat-card">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(hint)}</small>
  </article>`;
}

async function save() {
  if (!session) return setSaved("Login potreban", false, true);
  try {
    config = await clientFetch("/client-api/config", {
      method: "PUT",
      body: JSON.stringify(config)
    });
    dirty = false;
    setSaved("Sačuvano", true);
    renderAll();
  } catch {
    setSaved("Greška", false, true);
  }
}

async function clientFetch(url, options = {}) {
  return fetchJson(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Id": session?.tenantId || "",
      "X-Tenant-Token": session?.token || "",
      ...(options.headers || {})
    }
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function section(title, content) {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function queueBinder(inputId, setter, property) {
  bindQueue.push({ inputId, setter, property });
}

function bindInputs(root) {
  while (bindQueue.length) {
    const binding = bindQueue.shift();
    const input = root.querySelector(`#${CSS.escape(binding.inputId)}`);
    if (!input) continue;
    input.addEventListener("input", () => {
      binding.setter(input[binding.property]);
      markDirty();
      renderSidebar();
    });
  }
}

function textField(label, value, setter, extraClass = "", id = "") {
  const inputId = id || `field-${Math.random().toString(16).slice(2)}`;
  queueBinder(inputId, setter, "value");
  return `<div class="field ${extraClass}">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <input id="${inputId}" value="${escapeAttr(value || "")}" />
  </div>`;
}

function numberField(label, value, setter, min = "", max = "", step = "1") {
  const inputId = `field-${Math.random().toString(16).slice(2)}`;
  queueBinder(inputId, setter, "value");
  return `<div class="field">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <input id="${inputId}" type="number" min="${min}" max="${max}" step="${step}" value="${escapeAttr(value ?? "")}" />
  </div>`;
}

function textArea(label, value, setter, extraClass = "") {
  const inputId = `field-${Math.random().toString(16).slice(2)}`;
  queueBinder(inputId, setter, "value");
  return `<div class="field ${extraClass}">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <textarea id="${inputId}">${escapeHtml(value || "")}</textarea>
  </div>`;
}

function checkboxField(label, value, setter) {
  const inputId = `field-${Math.random().toString(16).slice(2)}`;
  queueBinder(inputId, setter, "checked");
  return `<label class="toggle-row" for="${inputId}">
    <input id="${inputId}" type="checkbox" ${value ? "checked" : ""} />
    <span>${escapeHtml(label)}</span>
  </label>`;
}

function selectField(label, value, options, setter, extraClass = "", id = "") {
  const inputId = id || `field-${Math.random().toString(16).slice(2)}`;
  if (setter) queueBinder(inputId, setter, "value");
  return `<div class="field ${extraClass}">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <select id="${inputId}">
      ${options.map((option) => `<option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
    </select>
  </div>`;
}

function activateTab(tab) {
  document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("active", name === tab));
}

function markDirty() {
  dirty = true;
  setSaved("Nesačuvano", false);
}

function setSaved(text, saved, error = false) {
  const status = document.querySelector("#saveStatus");
  status.textContent = text;
  status.classList.toggle("saved", saved);
  status.classList.toggle("error", error);
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem("metabot-client-session") || "null");
  } catch {
    return null;
  }
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
