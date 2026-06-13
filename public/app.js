let config;
let conversations = [];
let dirty = false;

const panels = {
  business: document.querySelector("#tab-business"),
  channels: document.querySelector("#tab-channels"),
  automation: document.querySelector("#tab-automation"),
  knowledge: document.querySelector("#tab-knowledge"),
  ai: document.querySelector("#tab-ai"),
  handoff: document.querySelector("#tab-handoff"),
  privacy: document.querySelector("#tab-privacy"),
  test: document.querySelector("#tab-test")
};

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

document.querySelector("#saveButton").addEventListener("click", save);

await boot();

async function boot() {
  config = await fetchJson("/api/config");
  conversations = await fetchJson("/api/conversations");
  renderAll();
  setSaved("Ucitano", true);
}

function renderAll() {
  renderBusiness();
  renderChannels();
  renderAutomation();
  renderKnowledge();
  renderAi();
  renderHandoff();
  renderPrivacy();
  renderTest();
  renderSidebar();
}

function renderBusiness() {
  panels.business.innerHTML = section(
    "Osnovno",
    `<div class="grid">
      ${textField("Naziv", config.business.name, (value) => (config.business.name = value))}
      ${textField("Jezik", config.business.language, (value) => (config.business.language = value))}
      ${textField("Vremenska zona", config.business.timezone, (value) => (config.business.timezone = value))}
      ${textField("Privacy URL", config.business.privacyNoticeUrl, (value) => (config.business.privacyNoticeUrl = value))}
      ${textArea("Kratak opis", config.business.shortDescription, (value) => (config.business.shortDescription = value), "full")}
      ${textArea("Podrazumevani odgovor", config.business.defaultReply, (value) => (config.business.defaultReply = value), "full")}
      ${textField("Data deletion URL", config.business.dataDeletionUrl, (value) => (config.business.dataDeletionUrl = value), "full")}
    </div>`
  );
  bindInputs(panels.business);
}

function renderChannels() {
  panels.channels.innerHTML = section(
    "Meta API",
    `<div class="grid">
      ${textField("Graph API verzija", config.meta.graphApiVersion, (value) => (config.meta.graphApiVersion = value))}
      ${textField("Verify token", config.meta.verifyToken, (value) => (config.meta.verifyToken = value))}
      ${checkboxField("Signature provera", config.meta.requireSignature, (value) => (config.meta.requireSignature = value))}
      ${textField("App secret env", config.meta.appSecretEnv, (value) => (config.meta.appSecretEnv = value))}
      ${textField("Page token env", config.meta.pageAccessTokenEnv, (value) => (config.meta.pageAccessTokenEnv = value), "full")}
    </div>`
  );

  panels.channels.insertAdjacentHTML(
    "beforeend",
    section(
    "Kanali",
    `<div class="collection">
      ${config.channels.map(channelItem).join("")}
    </div>
    <div class="actions">
      <button data-add-channel="messenger">Dodaj Messenger</button>
      <button data-add-channel="instagram">Dodaj Instagram</button>
    </div>`
    )
  );
  bindInputs(panels.channels);
  panels.channels.querySelectorAll("[data-add-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.addChannel;
      config.channels.push({
        id: `${type}-${Date.now()}`,
        type,
        name: type === "instagram" ? "Instagram Direct" : "Facebook Messenger",
        enabled: true,
        pageId: "",
        igAccountId: "",
        sendEnabled: false,
        pageAccessTokenEnv: "META_PAGE_ACCESS_TOKEN"
      });
      markDirty();
      renderChannels();
      renderSidebar();
    });
  });
  panels.channels.querySelectorAll("[data-remove-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      config.channels = config.channels.filter((channel) => channel.id !== button.dataset.removeChannel);
      markDirty();
      renderChannels();
      renderSidebar();
    });
  });
}

function channelItem(channel) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(channel.name)}</h3>
      <button class="danger" data-remove-channel="${channel.id}">Ukloni</button>
    </div>
    <div class="grid three">
      ${checkboxField("Aktivan", channel.enabled, (value) => (channel.enabled = value))}
      ${checkboxField("Slanje ukljuceno", channel.sendEnabled, (value) => (channel.sendEnabled = value))}
      ${selectField("Tip", channel.type, ["messenger", "instagram"], (value) => (channel.type = value))}
      ${textField("Naziv", channel.name, (value) => (channel.name = value))}
      ${textField("Page ID", channel.pageId, (value) => (channel.pageId = value))}
      ${textField("IG Account ID", channel.igAccountId, (value) => (channel.igAccountId = value))}
      ${textField("Token env", channel.pageAccessTokenEnv, (value) => (channel.pageAccessTokenEnv = value), "full")}
    </div>
  </article>`;
}

function renderAutomation() {
  panels.automation.innerHTML = section(
    "Automatizacija",
    `<div class="grid three">
      ${checkboxField("Bot aktivan", config.automation.enabled, (value) => (config.automation.enabled = value))}
      ${numberField("24h prozor", config.automation.policyWindowHours, (value) => (config.automation.policyWindowHours = Number(value)))}
      ${numberField("Human agent dani", config.automation.humanAgentWindowDays, (value) => (config.automation.humanAgentWindowDays = Number(value)))}
      ${numberField("FAQ prag", config.automation.confidenceThreshold, (value) => (config.automation.confidenceThreshold = Number(value)), 0, 1, 0.01)}
      ${textArea("Lead prompt", config.automation.leadCapturePrompt, (value) => (config.automation.leadCapturePrompt = value), "full")}
    </div>`
  );

  panels.automation.insertAdjacentHTML(
    "beforeend",
    section(
      "Prikupljanje podataka",
      `<div class="collection">
        ${config.automation.collectFields.map(fieldItem).join("")}
      </div>
      <div class="actions"><button id="addField">Dodaj polje</button></div>`
    )
  );

  panels.automation.insertAdjacentHTML(
    "beforeend",
    section(
      "Handoff okidaci",
      keywordEditor("handoffKeywords", config.automation.handoffKeywords)
    )
  );

  panels.automation.insertAdjacentHTML(
    "beforeend",
    section(
      "Rizicne reci",
      keywordEditor("riskyKeywords", config.automation.riskyKeywords)
    )
  );

  bindInputs(panels.automation);
  bindKeywordEditors(panels.automation);
  panels.automation.querySelector("#addField").addEventListener("click", () => {
    config.automation.collectFields.push({
      id: `field-${Date.now()}`,
      label: "novo polje",
      enabled: true,
      required: false
    });
    markDirty();
    renderAutomation();
  });
  panels.automation.querySelectorAll("[data-remove-field]").forEach((button) => {
    button.addEventListener("click", () => {
      config.automation.collectFields = config.automation.collectFields.filter((field) => field.id !== button.dataset.removeField);
      markDirty();
      renderAutomation();
    });
  });
}

function fieldItem(field) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(field.label)}</h3>
      <button class="danger" data-remove-field="${field.id}">Ukloni</button>
    </div>
    <div class="grid">
      ${textField("ID", field.id, (value) => (field.id = slug(value)))}
      ${textField("Labela", field.label, (value) => (field.label = value))}
      ${checkboxField("Aktivno", field.enabled, (value) => (field.enabled = value))}
      ${checkboxField("Obavezno", field.required, (value) => (field.required = value))}
    </div>
  </article>`;
}

function renderKnowledge() {
  panels.knowledge.innerHTML = section(
    "Pravila",
    `<div class="collection">${config.automation.rules.map(ruleItem).join("")}</div>
    <div class="actions"><button id="addRule">Dodaj pravilo</button></div>`
  );

  panels.knowledge.insertAdjacentHTML(
    "beforeend",
    section(
      "FAQ",
      `<div class="collection">${config.automation.faqs.map(faqItem).join("")}</div>
      <div class="actions"><button id="addFaq">Dodaj FAQ</button></div>`
    )
  );

  bindInputs(panels.knowledge);
  panels.knowledge.querySelector("#addRule").addEventListener("click", () => {
    config.automation.rules.push({
      id: `rule-${Date.now()}`,
      enabled: true,
      name: "Novo pravilo",
      keywords: ["kljucna rec"],
      response: "Odgovor bota",
      confidence: 0.9
    });
    markDirty();
    renderKnowledge();
  });
  panels.knowledge.querySelector("#addFaq").addEventListener("click", () => {
    config.automation.faqs.push({
      id: `faq-${Date.now()}`,
      enabled: true,
      question: "Novo pitanje",
      keywords: ["pitanje"],
      answer: "Odgovor"
    });
    markDirty();
    renderKnowledge();
  });
  panels.knowledge.querySelectorAll("[data-remove-rule]").forEach((button) => {
    button.addEventListener("click", () => {
      config.automation.rules = config.automation.rules.filter((rule) => rule.id !== button.dataset.removeRule);
      markDirty();
      renderKnowledge();
    });
  });
  panels.knowledge.querySelectorAll("[data-remove-faq]").forEach((button) => {
    button.addEventListener("click", () => {
      config.automation.faqs = config.automation.faqs.filter((faq) => faq.id !== button.dataset.removeFaq);
      markDirty();
      renderKnowledge();
    });
  });
}

function ruleItem(rule) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(rule.name)}</h3>
      <button class="danger" data-remove-rule="${rule.id}">Ukloni</button>
    </div>
    <div class="grid">
      ${checkboxField("Aktivno", rule.enabled, (value) => (rule.enabled = value))}
      ${numberField("Pouzdanje", rule.confidence, (value) => (rule.confidence = Number(value)), 0, 1, 0.01)}
      ${textField("Naziv", rule.name, (value) => (rule.name = value))}
      ${textField("Kljucne reci", rule.keywords.join(", "), (value) => (rule.keywords = splitCsv(value)))}
      ${textArea("Odgovor", rule.response, (value) => (rule.response = value), "full")}
    </div>
  </article>`;
}

function faqItem(faq) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(faq.question)}</h3>
      <button class="danger" data-remove-faq="${faq.id}">Ukloni</button>
    </div>
    <div class="grid">
      ${checkboxField("Aktivno", faq.enabled, (value) => (faq.enabled = value))}
      ${textField("Pitanje", faq.question, (value) => (faq.question = value))}
      ${textField("Kljucne reci", faq.keywords.join(", "), (value) => (faq.keywords = splitCsv(value)), "full")}
      ${textArea("Odgovor", faq.answer, (value) => (faq.answer = value), "full")}
    </div>
  </article>`;
}

function renderAi() {
  panels.ai.innerHTML = section(
    "AI fallback",
    `<div class="grid">
      ${checkboxField("Ukljucen", config.ai.enabled, (value) => (config.ai.enabled = value))}
      ${selectField("Provider", config.ai.provider, ["openai"], (value) => (config.ai.provider = value))}
      ${textField("Model", config.ai.model, (value) => (config.ai.model = value))}
      ${textField("API key env", config.ai.apiKeyEnv, (value) => (config.ai.apiKeyEnv = value))}
      ${numberField("Max karaktera", config.ai.maxInputChars, (value) => (config.ai.maxInputChars = Number(value)))}
      ${checkboxField("Greska vodi na handoff", config.ai.fallbackToHumanOnError, (value) => (config.ai.fallbackToHumanOnError = value))}
      ${textArea("System prompt", config.ai.systemPrompt, (value) => (config.ai.systemPrompt = value), "full")}
    </div>`
  );
  bindInputs(panels.ai);
}

function renderHandoff() {
  panels.handoff.innerHTML = section(
    "Handoff",
    `<div class="grid">
      ${checkboxField("Ukljucen", config.handoff.enabled, (value) => (config.handoff.enabled = value))}
      ${selectField("Mod", config.handoff.mode, ["conversation_routing", "manual_ticket", "inbox"], (value) => (config.handoff.mode = value))}
      ${textArea("Poruka", config.handoff.message, (value) => (config.handoff.message = value), "full")}
      ${checkboxField("Ticketing webhook", config.handoff.ticketing.enabled, (value) => (config.handoff.ticketing.enabled = value))}
      ${textField("Webhook env", config.handoff.ticketing.webhookUrlEnv, (value) => (config.handoff.ticketing.webhookUrlEnv = value))}
      ${textField("Provider", config.handoff.ticketing.provider, (value) => (config.handoff.ticketing.provider = value))}
    </div>`
  );
  bindInputs(panels.handoff);
}

function renderPrivacy() {
  panels.privacy.innerHTML = section(
    "Privatnost",
    `<div class="grid">
      ${numberField("Retention dana", config.privacy.retentionDays, (value) => (config.privacy.retentionDays = Number(value)))}
      ${checkboxField("Redakcija logova", config.privacy.redactLogs, (value) => (config.privacy.redactLogs = value))}
      ${checkboxField("Cuvaj raw evente", config.privacy.storeRawEvents, (value) => (config.privacy.storeRawEvents = value))}
    </div>
    <form id="deleteForm" class="actions">
      <input name="platformUserId" placeholder="Platform user ID" />
      <button class="danger">Obrisi podatke</button>
    </form>`
  );
  bindInputs(panels.privacy);
  panels.privacy.querySelector("#deleteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const platformUserId = new FormData(event.currentTarget).get("platformUserId");
    const result = await fetchJson("/api/privacy/delete-customer", {
      method: "POST",
      body: JSON.stringify({ platformUserId })
    });
    conversations = await fetchJson("/api/conversations");
    renderSidebar();
    setSaved(`Obrisano: ${result.deleted}`, true);
  });
}

function renderTest() {
  panels.test.innerHTML = section(
    "Test poruke",
    `<div class="grid">
      ${selectField("Kanal", "messenger", ["messenger", "instagram"], null, "", "testChannel")}
      <div class="field full">
        <label for="testText">Poruka</label>
        <textarea id="testText">Koje je radno vreme?</textarea>
      </div>
    </div>
    <div class="actions"><button id="runTest" class="primary">Testiraj</button></div>
    <div id="testResult" class="test-result"></div>`
  );

  panels.test.querySelector("#runTest").addEventListener("click", async () => {
    const result = await fetchJson("/api/test-message", {
      method: "POST",
      body: JSON.stringify({
        channelType: panels.test.querySelector("#testChannel").value,
        text: panels.test.querySelector("#testText").value
      })
    });
    renderTestResult(result);
  });
}

function renderTestResult(payload) {
  const result = payload.result;
  const className = result.action === "handoff" ? "handoff" : result.action === "fallback" ? "fallback" : "";
  panels.test.querySelector("#testResult").innerHTML = `
    <span class="pill ${className}">${escapeHtml(result.action)}</span>
    <strong>${escapeHtml(result.reply)}</strong>
    <span>Razlog: ${escapeHtml(result.reason)} | Pouzdanje: ${result.confidence}</span>
  `;
}

function renderSidebar() {
  const activeChannels = config.channels.filter((channel) => channel.enabled).length;
  const rules = config.automation.rules.filter((rule) => rule.enabled).length;
  const faqs = config.automation.faqs.filter((faq) => faq.enabled).length;
  document.querySelector("#statusList").innerHTML = `
    <dt>Kanali</dt><dd>${activeChannels}</dd>
    <dt>Pravila</dt><dd>${rules}</dd>
    <dt>FAQ</dt><dd>${faqs}</dd>
    <dt>AI</dt><dd>${config.ai.enabled ? "on" : "off"}</dd>
    <dt>Handoff</dt><dd>${config.handoff.enabled ? "on" : "off"}</dd>
  `;

  document.querySelector("#conversationList").innerHTML =
    conversations
      .slice(0, 12)
      .map((conversation) => {
        const last = conversation.messages?.at(-1);
        return `<article class="conversation">
          <strong>${escapeHtml(conversation.channelType)} · ${escapeHtml(conversation.status)}</strong>
          <span>${escapeHtml(conversation.platformUserId)}</span>
          <span>${escapeHtml(last?.body || "Nema poruka")}</span>
        </article>`;
      })
      .join("") || `<span class="conversation">Nema razgovora</span>`;
}

async function save() {
  try {
    config = await fetchJson("/api/config", {
      method: "PUT",
      body: JSON.stringify(config)
    });
    dirty = false;
    setSaved("Sacuvano", true);
    renderAll();
  } catch (error) {
    setSaved("Greska", false, true);
  }
}

function activateTab(tab) {
  document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("active", name === tab));
}

function section(title, content) {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${content}</section>`;
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

const bindQueue = [];

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

function keywordEditor(key, values) {
  return `<div class="collection" data-keyword-editor="${key}">
    ${values
      .map(
        (value, index) => `<div class="keyword-row">
          <input value="${escapeAttr(value)}" data-keyword-index="${index}" />
          <button class="danger" data-remove-keyword="${index}">Ukloni</button>
        </div>`
      )
      .join("")}
    <div class="actions"><button data-add-keyword="${key}">Dodaj rec</button></div>
  </div>`;
}

function bindKeywordEditors(root) {
  root.querySelectorAll("[data-keyword-editor]").forEach((editor) => {
    const key = editor.dataset.keywordEditor;
    editor.querySelectorAll("[data-keyword-index]").forEach((input) => {
      input.addEventListener("input", () => {
        config.automation[key][Number(input.dataset.keywordIndex)] = input.value;
        markDirty();
      });
    });
    editor.querySelectorAll("[data-remove-keyword]").forEach((button) => {
      button.addEventListener("click", () => {
        config.automation[key].splice(Number(button.dataset.removeKeyword), 1);
        markDirty();
        renderAutomation();
      });
    });
    editor.querySelector("[data-add-keyword]").addEventListener("click", () => {
      config.automation[key].push("nova rec");
      markDirty();
      renderAutomation();
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }
  return response.json();
}

function markDirty() {
  dirty = true;
  setSaved("Nesacuvano", false);
}

function setSaved(text, saved, error = false) {
  const status = document.querySelector("#saveStatus");
  status.textContent = text;
  status.classList.toggle("saved", saved);
  status.classList.toggle("error", error);
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
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
