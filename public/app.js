let config;
let tenants = [];
let currentTenantId = "default";
let conversations = [];
let tenantStore = null;
let dashboard = null;
let dirty = false;
let editingTenant = false;
const bindQueue = [];

const panels = {
  dashboard: document.querySelector("#tab-dashboard"),
  business: document.querySelector("#tab-business"),
  tenants: document.querySelector("#tab-tenants"),
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
document.querySelector("#logoutButton").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login.html";
});
document.querySelector("#tenantSelect").addEventListener("change", async (event) => {
  if (dirty && !window.confirm("Imas nesacuvane izmene. Nastaviti bez cuvanja?")) {
    event.currentTarget.value = currentTenantId;
    return;
  }
  await switchTenant(event.currentTarget.value, "dashboard");
});

try {
  await boot();
} catch (error) {
  console.error("Boot failed:", error);
  setSaved("Greska", false, true);
  document.querySelector(".workspace").innerHTML = `
    <section class="section" style="border-color: var(--danger); text-align: center; padding: 40px; background: rgba(180, 35, 24, 0.05);">
      <h2 style="color: var(--danger); margin-bottom: 12px;">Greška pri povezivanju sa serverom</h2>
      <p style="color: var(--muted); margin-bottom: 24px;">
        Ne možemo učitati konfiguraciju niti razgovore sa servera. Proverite da li je backend servis pokrenut i pokušajte ponovo.
      </p>
      <pre style="white-space: pre-wrap; text-align: left; color: var(--muted); background: rgba(0,0,0,.2); padding: 12px; border-radius: 8px;">${escapeHtml(error.message || error)}</pre>
      <button onclick="window.location.reload()" class="primary">Pokušaj ponovo</button>
    </section>
  `;
}

async function boot() {
  tenants = await fetchJson("/api/tenants");
  dashboard = await fetchJson("/api/dashboard");
  currentTenantId = tenants[0]?.id || "default";
  renderTenantSelect();
  await loadTenantWorkspace();
  setEditMode(false);
  renderAll();
  activateTab("dashboard");
  setSaved("Ucitano", true);
}

async function loadTenantWorkspace() {
  const [nextConfig, nextConversations, nextStore, nextDashboard] = await Promise.all([
    fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/config`),
    fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/conversations`),
    fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/store`),
    fetchJson("/api/dashboard")
  ]);
  config = normalizeClientConfig(nextConfig);
  conversations = nextConversations;
  tenantStore = nextStore;
  dashboard = nextDashboard;
  renderTenantSelect();
  setEditMode(editingTenant);
  renderAll();
}

function renderAll() {
  const steps = [
    ["dashboard", renderDashboard],
    ["tenants", renderTenants],
    ["sidebar", renderSidebar]
  ];
  if (editingTenant) {
    steps.splice(2, 0,
      ["business", renderBusiness],
      ["channels", renderChannels],
      ["automation", renderAutomation],
      ["knowledge", renderKnowledge],
      ["ai", renderAi],
      ["handoff", renderHandoff],
      ["privacy", renderPrivacy],
      ["test", renderTest]
    );
  } else {
    clearEditorPanels();
  }

  for (const [name, render] of steps) {
    try {
      render();
    } catch (error) {
      console.error(`Render failed: ${name}`, error);
      if (panels[name]) {
        panels[name].innerHTML = section("Greška u sekciji", `<pre style="white-space: pre-wrap; color: var(--muted);">${escapeHtml(error.message || error)}</pre>`);
      }
      throw error;
    }
  }
}

function renderDashboard() {
  const items = dashboard?.tenants || [];
  const selected = items.find((item) => item.id === currentTenantId) || items[0] || {};
  const stats = selected.stats || {};
  const usage = selected.usage || {};
  const remaining = Math.max(0, 100 - Number(usage.percentUsed || 0));
  const automationHealth = computeAutomationHealth(selected, stats, usage);
  panels.dashboard.innerHTML = `
    <section class="client-focus-hero" style="--client-color: ${escapeAttr(selected.color || "#10b981")}; --usage: ${remaining}%">
      <div class="client-orbit">${remaining}%</div>
      <div>
        <p class="eyebrow">Izabrani klijent</p>
        <h2>${escapeHtml(selected.business?.name || selected.name || "Nema klijenta")}</h2>
        <p>${escapeHtml(selected.niche || selected.business?.sourceUrl || "Izaberi klijenta iz padajuceg menija da vidis samo njegove podatke.")}</p>
        <div class="hero-actions">
          <button class="primary" data-edit-current>Izmeni klijenta</button>
          <button data-open-client-list>Lista klijenata</button>
        </div>
      </div>
      <div class="metric-ring-group">
        ${ringMetric("API", remaining, "preostalo", selected.color || "#10b981")}
        ${ringMetric("Health", automationHealth, "spremno", "#3b82f6")}
      </div>
    </section>

    <section class="stat-grid">
      ${statCard("Poruke danas", stats.messagesToday || 0, "Samo ovaj klijent")}
      ${statCard("AI odgovori", stats.botRepliesToday || 0, "Automatski odgovori danas")}
      ${statCard("Razgovori", stats.conversations || 0, "Cuvaju se 30 dana")}
      ${statCard("Narudzbine", stats.orders || 0, "Zabelezeni leadovi")}
      ${statCard("Reklamacije", stats.complaints || 0, "Zamene, kasnjenja i problemi")}
      ${statCard("Handoff", stats.handoffs || 0, "Treba ljudska provera")}
      ${statCard("Proizvodi", stats.products || 0, "Iz ucitanog shopa")}
      ${statCard("Kanali", stats.activeChannels || 0, "Instagram/Facebook")}
    </section>

    ${section(
      "Brzi izbor klijenta",
      `<div class="tenant-color-strip">
        ${items.map((tenant) => `<button class="${tenant.id === currentTenantId ? "active" : ""}" data-open-dashboard-tenant="${escapeAttr(tenant.id)}" style="--client-color: ${escapeAttr(tenant.color || "#10b981")}">
          <span></span>${escapeHtml(tenant.name)}
        </button>`).join("") || `<div class="empty-state">Nema dodatih klijenata.</div>`}
      </div>`
    )}

    ${section(
      "Aktivnost AI Agenta (Simulacija uživo)",
      `<div class="chat-preview-shell">
        <div class="chat-preview-header">
          <div class="chat-preview-user">
            <span class="chat-preview-avatar"></span>
            <div>
              <h4>Kupac (Simulacija)</h4>
              <small>Zainteresovan za proizvode</small>
            </div>
          </div>
          <span class="chat-live-badge"><span class="status-pulse"></span>Live</span>
        </div>
        <div class="chat-preview-body">
          <div class="chat-msg user-msg">Eja, da li imate na stanju srebrnu ogrlicu i kolika je cena dostave?</div>
          <div class="chat-msg bot-msg typing">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </div>
          <div class="chat-msg bot-msg reply-msg">Zdravo! Imamo srebrnu ogrlicu na stanju po ceni od 2.400 RSD. Dostava je besplatna za sve porudžbine preko 4.000 RSD, inače je 350 RSD. Ako želite da poručite, ostavite ime, prezime, adresu i broj telefona.</div>
        </div>
      </div>`
    )}
  `;

  panels.dashboard.querySelectorAll("[data-open-dashboard-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      await switchTenant(button.dataset.openDashboardTenant, "dashboard");
    });
  });
  panels.dashboard.querySelector("[data-edit-current]")?.addEventListener("click", () => openTenantEditor(currentTenantId));
  panels.dashboard.querySelector("[data-open-client-list]")?.addEventListener("click", () => {
    editingTenant = false;
    setEditMode(false);
    activateTab("tenants");
  });
}

function dashboardBusinessItem(tenant) {
  const remaining = Math.max(0, 100 - Number(tenant.usage?.percentUsed || 0));
  return `<article class="business-row">
    <div class="business-main">
      <h3><span class="status-pulse ${tenant.status === 'pending' ? 'pending' : ''}"></span>${escapeHtml(tenant.business?.name || tenant.name)}</h3>
      <span>${escapeHtml(tenant.ownerEmail || "nema email")} · ${escapeHtml(tenant.id)}</span>
      <small>${escapeHtml(tenant.business?.sourceUrl || "shop URL nije ubacen")}</small>
    </div>
    <div class="business-metric">
      <strong>${tenant.stats?.botRepliesToday || 0}</strong>
      <span>odgovora danas</span>
    </div>
    <div class="business-metric">
      <strong>${tenant.stats?.orders || 0}</strong>
      <span>narudzbine</span>
    </div>
    <div class="business-metric">
      <strong>${tenant.stats?.handoffs || 0}</strong>
      <span>handoff</span>
    </div>
    <div class="business-usage">
      <div>
        <strong>${remaining}%</strong>
        <span>API preostalo</span>
      </div>
      ${usageBar(remaining, "preostalo")}
    </div>
    <button data-open-dashboard-tenant="${escapeAttr(tenant.id)}" class="primary">Otvori</button>
  </article>`;
}

function statCard(label, value, hint) {
  // Generate a stable aesthetic sparkline path and trending percentage based on label string seed
  const seed = String(label).charCodeAt(0) + String(label).charCodeAt(String(label).length - 1 || 0);
  const trendUp = seed % 2 === 0;
  const trendVal = (seed % 15 + 4).toFixed(1);
  const sparkPoints = [];
  let currentY = 14;
  for (let i = 0; i < 6; i++) {
    const change = ((seed + i * 7) % 12) - 6;
    currentY = Math.max(2, Math.min(26, currentY + (trendUp ? -change : change)));
    sparkPoints.push(`${i * 12 + 5},${currentY}`);
  }
  const sparkPath = `M ${sparkPoints.join(' L ')}`;
  const trendClass = trendUp ? 'up' : 'down';
  const trendIcon = trendUp ? '↑' : '↓';
  const strokeClass = trendUp ? '' : 'blue';

  return `<article class="stat-card">
    <div class="stat-card-header">
      <span>${escapeHtml(label)}</span>
      <div class="trend-badge ${trendClass}">${trendIcon} ${trendVal}%</div>
    </div>
    <strong>${escapeHtml(value)}</strong>
    <div class="stat-card-footer">
      <small>${escapeHtml(hint)}</small>
      <svg class="sparkline-container" viewBox="0 0 70 28" aria-hidden="true">
        <path class="sparkline-path ${strokeClass}" d="${sparkPath}" />
      </svg>
    </div>
  </article>`;
}

function usageBar(value, label = "") {
  const safeValue = Math.max(0, Math.min(100, Number(value || 0)));
  return `<div class="usage-bar large" aria-label="${escapeAttr(label)}" style="--usage: ${safeValue}%"><span></span></div>`;
}

function ringMetric(label, value, hint, color) {
  const safeValue = Math.max(0, Math.min(100, Number(value || 0)));
  return `<div class="ring-metric" style="--ring-value:${safeValue}%; --ring-color:${escapeAttr(color)}">
    <strong>${Math.round(safeValue)}%</strong>
    <span>${escapeHtml(label)}</span>
    <small>${escapeHtml(hint)}</small>
  </div>`;
}

function computeAutomationHealth(tenant, stats, usage) {
  let score = 0;
  if ((stats.activeChannels || 0) > 0) score += 22;
  if ((stats.products || 0) > 0) score += 18;
  if ((stats.knowledge || 0) > 0 || (tenant.business?.sourceUrl || tenant.niche)) score += 18;
  if (tenant.status === "active") score += 14;
  if (Number(usage.percentUsed || 0) < 95) score += 14;
  if ((stats.handoffs || 0) >= 0) score += 14;
  return Math.min(100, score);
}

async function openTenantEditor(tenantId) {
  currentTenantId = tenantId || currentTenantId;
  dirty = false;
  editingTenant = true;
  setEditMode(true);
  activateTab("business", { keepEditMode: true });
  setSaved("Ucitavam izmenu...", false);
  await loadTenantWorkspace();
  setEditMode(true);
  activateTab("business", { keepEditMode: true });
  setSaved("Izmena otvorena", true);
}

function setEditMode(enabled) {
  editingTenant = Boolean(enabled);
  document.querySelectorAll(".edit-tab").forEach((button) => {
    button.hidden = !editingTenant;
  });
  document.body.classList.toggle("editing-tenant", editingTenant);
  if (!editingTenant) clearEditorPanels();
}

function clearEditorPanels() {
  for (const name of ["business", "channels", "automation", "knowledge", "ai", "handoff", "privacy", "test"]) {
    if (panels[name]) panels[name].innerHTML = "";
  }
}

async function switchTenant(tenantId, tab = "dashboard") {
  if (!tenantId || tenantId === currentTenantId && !editingTenant) {
    activateTab(tab);
    return;
  }

  currentTenantId = tenantId;
  dirty = false;
  editingTenant = false;
  setEditMode(false);
  renderTenantSelect();
  renderDashboard();
  renderSidebar();
  activateTab(tab);
  setSaved("Ucitavam...", false);

  await loadTenantWorkspace();
  activateTab(tab);
  setSaved("Ucitano", true);
}

function renderTenantSelect() {
  const select = document.querySelector("#tenantSelect");
  select.innerHTML = tenants
    .map((tenant) => `<option value="${escapeAttr(tenant.id)}" ${tenant.id === currentTenantId ? "selected" : ""}>${escapeHtml(tenant.name)} (${escapeHtml(tenant.id)})</option>`)
    .join("");
}

function renderTenants() {
  const pending = tenants.filter((tenant) => tenant.status === "pending");
  const active = tenants.filter((tenant) => tenant.status !== "pending");
  panels.tenants.innerHTML = section(
    "Klijenti",
    `<div class="setup-flow">
      <article><span>1</span><strong>Signup</strong><small>Klijent salje kratak zahtev sa landing stranice.</small></article>
      <article><span>2</span><strong>Odobrenje</strong><small>Login dobija tek kada ga master admin odobri.</small></article>
      <article><span>3</span><strong>Izmena</strong><small>Detaljna podesavanja se otvaraju samo kroz Izmeni.</small></article>
      <article><span>4</span><strong>Pokretanje</strong><small>Ukljucis kanale, API, znanje i pratis metrike.</small></article>
    </div>
    <div class="actions clients-toolbar"><button id="showAddTenant" class="primary">Dodaj novog klijenta</button></div>
    <div id="addTenantPanel" class="wizard-panel" hidden>
      <form id="addTenantForm" class="wizard-grid">
        <section>
          <h3>1. Osnovno</h3>
          <div class="field"><label for="newTenantName">Naziv klijenta</label><input id="newTenantName" name="name" required placeholder="Novi klijent" /></div>
          <div class="field"><label for="newTenantEmail">Email vlasnika</label><input id="newTenantEmail" name="ownerEmail" type="email" placeholder="klijent@example.com" /></div>
          <div class="field"><label for="newTenantNiche">Niche</label><input id="newTenantNiche" name="niche" placeholder="Odeca, nakit, custom pokloni..." /></div>
        </section>
        <section>
          <h3>2. AI i API</h3>
          <div class="field"><label for="newTenantApiEnv">API key env</label><input id="newTenantApiEnv" name="apiKeyEnv" placeholder="OPENAI_API_KEY_KLIJENT" /></div>
          <div class="field"><label for="newTenantModel">Model</label><input id="newTenantModel" name="model" value="gpt-4.1-mini" /></div>
          <div class="field"><label for="newTenantLimit">Mesecni limit ($)</label><input id="newTenantLimit" name="monthlyLimitUsd" type="number" value="20" /></div>
        </section>
        <section>
          <h3>3. Kanali</h3>
          <label class="toggle-row"><input name="messenger" type="checkbox" checked /><span>Facebook Messenger</span></label>
          <label class="toggle-row"><input name="instagram" type="checkbox" checked /><span>Instagram Direct</span></label>
        </section>
        <section>
          <h3>4. Shop i Sheet</h3>
          <div class="field"><label for="newTenantSite">URL sajta</label><input id="newTenantSite" name="sourceUrl" placeholder="https://shop.com" /></div>
          <div class="field"><label for="newTenantSheet">Google Sheet URL</label><input id="newTenantSheet" name="sheetUrl" placeholder="https://docs.google.com/spreadsheets/..." /></div>
        </section>
        <div class="actions full"><button class="primary">Kreiraj i otvori podesavanja</button></div>
      </form>
    </div>
    ${pending.length ? `<h2>Pending prijave</h2><div class="collection">${pending.map(tenantItem).join("")}</div>` : ""}
    <h2>Aktivni i ostali klijenti</h2>
    <div class="client-table">${active.map(tenantItem).join("") || `<div class="empty-state">Nema aktivnih klijenata.</div>`}</div>`
  );

  panels.tenants.querySelector("#showAddTenant").addEventListener("click", () => {
    const panel = panels.tenants.querySelector("#addTenantPanel");
    panel.hidden = !panel.hidden;
  });

  panels.tenants.querySelector("#addTenantForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tenant = await fetchJson("/api/tenants", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        ownerEmail: form.get("ownerEmail"),
        niche: form.get("niche")
      })
    });
    const createdConfig = normalizeClientConfig(await fetchJson(`/api/tenants/${encodeURIComponent(tenant.id)}/config`));
    createdConfig.ai.apiKeyEnv = form.get("apiKeyEnv") || createdConfig.ai.apiKeyEnv;
    createdConfig.ai.model = form.get("model") || createdConfig.ai.model;
    createdConfig.usage.monthlyLimitUsd = Number(form.get("monthlyLimitUsd") || 20);
    createdConfig.catalog.sourceUrl = form.get("sourceUrl") || "";
    createdConfig.integrations.googleSheets.enabled = Boolean(form.get("sheetUrl"));
    createdConfig.integrations.googleSheets.sheetUrl = form.get("sheetUrl") || "";
    createdConfig.channels = [
      ...(form.get("messenger") ? [{
        id: `messenger-${Date.now()}`,
        type: "messenger",
        name: "Facebook Messenger",
        enabled: true,
        pageId: "",
        igAccountId: "",
        sendEnabled: false,
        pageAccessTokenEnv: "META_PAGE_ACCESS_TOKEN",
        pageAccessTokenValue: "",
        hasPageAccessToken: false
      }] : []),
      ...(form.get("instagram") ? [{
        id: `instagram-${Date.now()}`,
        type: "instagram",
        name: "Instagram Direct",
        enabled: true,
        pageId: "",
        igAccountId: "",
        sendEnabled: false,
        pageAccessTokenEnv: "META_PAGE_ACCESS_TOKEN",
        pageAccessTokenValue: "",
        hasPageAccessToken: false
      }] : [])
    ];
    await fetchJson(`/api/tenants/${encodeURIComponent(tenant.id)}/config`, {
      method: "PUT",
      body: JSON.stringify(createdConfig)
    });
    tenants = await fetchJson("/api/tenants");
    currentTenantId = tenant.id;
    dirty = false;
    editingTenant = true;
    await loadTenantWorkspace();
    openTenantEditor(tenant.id);
    setSaved("Klijent dodat", true);
  });

  panels.tenants.querySelectorAll("[data-open-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (dirty && !window.confirm("Imas nesacuvane izmene. Nastaviti bez cuvanja?")) return;
      await switchTenant(button.dataset.openTenant, "dashboard");
    });
  });
  panels.tenants.querySelectorAll("[data-edit-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (dirty && !window.confirm("Imas nesacuvane izmene. Nastaviti bez cuvanja?")) return;
      await openTenantEditor(button.dataset.editTenant);
    });
  });

  panels.tenants.querySelectorAll("[data-reset-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      const access = await fetchJson(`/api/tenants/${encodeURIComponent(button.dataset.resetTenant)}/access`, {
        method: "POST",
        body: "{}"
      });
      window.alert(`Client login:\n${window.location.origin}/client.html?tenant=${access.tenantId}\n\nPassword:\n${access.password}`);
    });
  });

  panels.tenants.querySelectorAll("[data-approve-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      const access = await fetchJson(`/api/tenants/${encodeURIComponent(button.dataset.approveTenant)}/approve`, {
        method: "POST",
        body: "{}"
      });
      tenants = await fetchJson("/api/tenants");
      window.alert(access.password
        ? `Klijent odobren:\n${window.location.origin}/login.html\n\nKlijent ID: ${access.tenantId}\nPrivremena lozinka: ${access.password}`
        : `Klijent odobren:\n${window.location.origin}/login.html\n\nKlijent se loguje emailom ili ID-em i lozinkom koju je uneo na signup-u.`);
      renderTenants();
      renderTenantSelect();
    });
  });

  panels.tenants.querySelectorAll("[data-reject-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Odbiti i trajno obrisati ovaj zahtev iz baze?")) return;
      await fetchJson(`/api/tenants/${encodeURIComponent(button.dataset.rejectTenant)}/reject`, {
        method: "POST",
        body: "{}"
      });
      tenants = await fetchJson("/api/tenants");
      renderTenants();
      renderTenantSelect();
    });
  });

  panels.tenants.querySelectorAll("[data-delete-tenant]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Trajno obrisati klijenta i sve njegove podatke iz baze?")) return;
      await fetchJson(`/api/tenants/${encodeURIComponent(button.dataset.deleteTenant)}`, {
        method: "DELETE"
      });
      if (currentTenantId === button.dataset.deleteTenant) {
        currentTenantId = "default";
        await loadTenantWorkspace();
      }
      tenants = await fetchJson("/api/tenants");
      renderTenants();
      renderTenantSelect();
      renderSidebar();
      setSaved("Klijent obrisan", true);
    });
  });
}

function tenantItem(tenant) {
  const stats = tenant.stats || {};
  const webhookUrl = `${window.location.origin}/webhook/${tenant.id}`;
  const remaining = Math.max(0, 100 - Number(tenant.usage?.percentUsed || 0));
  return `<article class="client-row" style="--client-color:${escapeAttr(tenant.color || "#10b981")}">
    <div class="client-row-main">
      <span class="client-avatar"></span>
      <div>
        <h3><span class="status-pulse ${tenant.status === 'pending' ? 'pending' : ''}"></span>${escapeHtml(tenant.name)}</h3>
        <small>${escapeHtml(tenant.niche || "niche nije dodat")} · ${escapeHtml(tenant.ownerEmail || "bez emaila")}</small>
      </div>
    </div>
    <div class="client-row-kpis">
      <span><strong>${stats.botRepliesToday || 0}</strong> AI odgovora</span>
      <span><strong>${stats.orders || 0}</strong> narudzbine</span>
      <span><strong>${stats.handoffs || 0}</strong> handoff</span>
      <span><strong>${remaining}%</strong> API</span>
    </div>
    <div class="client-row-links">
      <input readonly value="${escapeAttr(webhookUrl)}" />
      <input readonly value="${escapeAttr(`${window.location.origin}/client.html?tenant=${tenant.id}`)}" />
    </div>
    <div class="actions">
      <button data-open-tenant="${escapeAttr(tenant.id)}">Dashboard</button>
      ${tenant.status === "pending" ? `<button class="primary" data-approve-tenant="${escapeAttr(tenant.id)}">Odobri</button><button class="danger" data-reject-tenant="${escapeAttr(tenant.id)}">Odbij</button>` : `<button class="primary" data-edit-tenant="${escapeAttr(tenant.id)}">Izmeni</button><button data-reset-tenant="${escapeAttr(tenant.id)}">Reset login</button>${tenant.id === "default" ? "" : `<button class="danger" data-delete-tenant="${escapeAttr(tenant.id)}">Obrisi</button>`}`}
    </div>
  </article>`;
}

function renderBusiness() {
  config.catalog ||= {};
  config.integrations ||= {};
  config.integrations.googleSheets ||= {};
  config.usage ||= {};
  const tenant = tenants.find((item) => item.id === currentTenantId) || {};
  panels.business.innerHTML = `
    <section class="editor-shell" style="--client-color:${escapeAttr(tenant.color || "#10b981")}">
      <div>
        <p class="eyebrow">Izmena klijenta</p>
        <h2>${escapeHtml(tenant.name || config.business.name || currentTenantId)}</h2>
        <p>Ovde menjas kompletno podesavanje za izabranog klijenta. Klijent vidi samo svoj portal, brojeve, narudzbine, reklamacije i znanje koje mu dozvolis.</p>
      </div>
      <div class="actions">
        <button data-close-editor>Vrati se na dashboard</button>
        <button class="primary" data-save-editor>Sacuvaj izmene</button>
      </div>
    </section>
    ${section(
    "Osnovno",
    `<div class="grid">
      ${textField("Naziv", config.business.name, (value) => (config.business.name = value))}
      ${textField("Jezik", config.business.language, (value) => (config.business.language = value))}
      ${textField("Vremenska zona", config.business.timezone, (value) => (config.business.timezone = value))}
      ${textField("Link politike privatnosti", config.business.privacyNoticeUrl, (value) => (config.business.privacyNoticeUrl = value))}
      ${textArea("Kratak opis", config.business.shortDescription, (value) => (config.business.shortDescription = value), "full")}
      ${textArea("Podrazumevani odgovor", config.business.defaultReply, (value) => (config.business.defaultReply = value), "full")}
      ${textField("Link za brisanje podataka", config.business.dataDeletionUrl, (value) => (config.business.dataDeletionUrl = value), "full")}
      ${textField("URL sajta / shopa", config.catalog.sourceUrl, (value) => (config.catalog.sourceUrl = value), "full")}
      ${numberField("Osvezavanje sajta na sati", config.catalog.refreshEveryHours, (value) => (config.catalog.refreshEveryHours = Number(value)))}
      ${numberField("Mesecni AI limit ($)", config.usage.monthlyLimitUsd, (value) => (config.usage.monthlyLimitUsd = Number(value)))}
      ${checkboxField("Google Sheet ukljucen", config.integrations.googleSheets.enabled, (value) => (config.integrations.googleSheets.enabled = value))}
      ${textField("Google Sheet webhook URL za porudzbine", config.integrations.googleSheets.webhookUrl, (value) => (config.integrations.googleSheets.webhookUrl = value), "full")}
      ${textField("Google Sheet pregledni link", config.integrations.googleSheets.sheetUrl, (value) => (config.integrations.googleSheets.sheetUrl = value), "full")}
    </div>`
  )}`;
  panels.business.insertAdjacentHTML(
    "beforeend",
    section(
      "Sajt i katalog",
      `<div class="actions">
        <button id="syncSite" class="primary">Sync sajt za ovog klijenta</button>
      </div>
      <div class="test-result">
        <span>Proizvodi: ${tenantStore?.catalog?.products?.length || 0}</span>
        <span>Pravila: ${tenantStore?.catalog?.policies?.length || 0}</span>
        <span>Orders/Reklamacije: ${tenantStore?.orders?.length || 0}</span>
      </div>`
    )
  );
  bindInputs(panels.business);
  panels.business.querySelector("[data-close-editor]").addEventListener("click", () => {
    editingTenant = false;
    setEditMode(false);
    activateTab("dashboard");
  });
  panels.business.querySelector("[data-save-editor]").addEventListener("click", save);
  panels.business.querySelector("#syncSite").addEventListener("click", async () => {
    setSaved("Ucitavam sajt...", false);
    const result = await fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/sync-site`, {
      method: "POST",
      body: JSON.stringify({ sourceUrl: config.catalog.sourceUrl })
    });
    config = normalizeClientConfig(result.config);
    tenantStore = await fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/store`);
    setSaved(`Ucitan sajt: ${result.products} proizvoda`, true);
    renderAll();
  });
}

function renderChannels() {
  panels.channels.innerHTML = section(
    "Meta API",
    `<div class="grid">
      ${textField("Graph API verzija", config.meta.graphApiVersion, (value) => (config.meta.graphApiVersion = value))}
      ${textField("Verify token", config.meta.verifyToken, (value) => (config.meta.verifyToken = value))}
      ${checkboxField("Signature provera", config.meta.requireSignature, (value) => (config.meta.requireSignature = value))}
      ${secretField("App secret", config.meta.appSecretValue, Boolean(config.meta.hasAppSecret), (value) => (config.meta.appSecretValue = value))}
      ${secretField("Page access token", config.meta.pageAccessTokenValue, Boolean(config.meta.hasPageAccessToken), (value) => (config.meta.pageAccessTokenValue = value), "full")}
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
        pageAccessTokenEnv: "META_PAGE_ACCESS_TOKEN",
        pageAccessTokenValue: "",
        hasPageAccessToken: false
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
      ${secretField("Page access token za ovaj kanal", channel.pageAccessTokenValue, Boolean(channel.hasPageAccessToken), (value) => (channel.pageAccessTokenValue = value), "full")}
    </div>
  </article>`;
}

function renderAutomation() {
  panels.automation.innerHTML = section(
    "Automatizacija",
    `<div class="grid three">
      ${checkboxField("AI automatizacija aktivna", config.automation.enabled, (value) => (config.automation.enabled = value))}
      ${numberField("24h prozor", config.automation.policyWindowHours, (value) => (config.automation.policyWindowHours = Number(value)))}
      ${numberField("Human agent dani", config.automation.humanAgentWindowDays, (value) => (config.automation.humanAgentWindowDays = Number(value)))}
      ${numberField("Dedup sati", config.automation.deduplicationWindowHours, (value) => (config.automation.deduplicationWindowHours = Number(value)))}
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
    "Baza znanja",
    `<div class="grid three">
      ${checkboxField("Ukljucena", config.knowledge.enabled, (value) => (config.knowledge.enabled = value))}
      ${numberField("Min skor", config.knowledge.minScore, (value) => (config.knowledge.minScore = Number(value)), 0, 1, 0.01)}
      ${numberField("Auto odgovor skor", config.knowledge.autoReplyThreshold, (value) => (config.knowledge.autoReplyThreshold = Number(value)), 0, 1, 0.01)}
      ${numberField("Max izvora", config.knowledge.maxMatches, (value) => (config.knowledge.maxMatches = Number(value)))}
    </div>
    <div class="collection">${config.knowledge.documents.map(knowledgeDocumentItem).join("")}</div>
    <div class="actions"><button id="addKnowledgeDocument">Dodaj dokument</button></div>`
  );

  panels.knowledge.insertAdjacentHTML(
    "beforeend",
    section(
    "Pravila",
    `<div class="collection">${config.automation.rules.map(ruleItem).join("")}</div>
    <div class="actions"><button id="addRule">Dodaj pravilo</button></div>`
    )
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
  panels.knowledge.querySelector("#addKnowledgeDocument").addEventListener("click", () => {
    config.knowledge.documents.push({
      id: `knowledge-${Date.now()}`,
      enabled: true,
      title: "Novi dokument",
      keywords: ["kljucna rec"],
      content: "Sadrzaj baze znanja",
      response: ""
    });
    markDirty();
    renderKnowledge();
  });
  panels.knowledge.querySelector("#addRule").addEventListener("click", () => {
    config.automation.rules.push({
      id: `rule-${Date.now()}`,
      enabled: true,
      name: "Novo pravilo",
      keywords: ["kljucna rec"],
      response: "Odgovor automatizacije",
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
  panels.knowledge.querySelectorAll("[data-remove-knowledge]").forEach((button) => {
    button.addEventListener("click", () => {
      config.knowledge.documents = config.knowledge.documents.filter((document) => document.id !== button.dataset.removeKnowledge);
      markDirty();
      renderKnowledge();
    });
  });
}

function knowledgeDocumentItem(document) {
  return `<article class="item">
    <div class="item-header">
      <h3>${escapeHtml(document.title)}</h3>
      <button class="danger" data-remove-knowledge="${document.id}">Ukloni</button>
    </div>
    <div class="grid">
      ${checkboxField("Aktivno", document.enabled, (value) => (document.enabled = value))}
      ${textField("ID", document.id, (value) => (document.id = slug(value)))}
      ${textField("Naslov", document.title, (value) => (document.title = value))}
      ${textField("Kljucne reci", document.keywords.join(", "), (value) => (document.keywords = splitCsv(value)))}
      ${textArea("Sadrzaj", document.content, (value) => (document.content = value), "full")}
      ${textArea("Direktan odgovor", document.response, (value) => (document.response = value), "full")}
    </div>
  </article>`;
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
  config.ai.modelRouting ||= {
    enabled: true,
    simpleModel: "gpt-5.4-nano",
    standardModel: "gpt-5.4-mini",
    complexModel: "gpt-5.5",
    visionModel: "gpt-5.5",
    standardMinChars: 280,
    complexMinChars: 1200,
    complexKeywords: []
  };

  panels.ai.innerHTML = section(
    "AI fallback",
    `<div class="grid">
      ${checkboxField("Ukljucen", config.ai.enabled, (value) => (config.ai.enabled = value))}
      ${selectField("Provider", config.ai.provider, ["openai", "gemini"], (value) => {
        config.ai.provider = value;
        if (value === "gemini" && config.ai.apiKeyEnv === "OPENAI_API_KEY") config.ai.apiKeyEnv = "GEMINI_API_KEY";
        if (value === "gemini" && config.ai.model.startsWith("gpt-")) config.ai.model = "gemini-2.5-flash";
        if (value === "openai" && config.ai.apiKeyEnv === "GEMINI_API_KEY") config.ai.apiKeyEnv = "OPENAI_API_KEY";
        if (value === "openai" && config.ai.model.startsWith("gemini-")) config.ai.model = "gpt-5.5";
      })}
      ${textField("Model", config.ai.model, (value) => (config.ai.model = value))}
      ${textField("API key env", config.ai.apiKeyEnv, (value) => (config.ai.apiKeyEnv = value))}
      ${numberField("Max karaktera", config.ai.maxInputChars, (value) => (config.ai.maxInputChars = Number(value)))}
      ${numberField("Max izlaz tokena", config.ai.maxOutputTokens, (value) => (config.ai.maxOutputTokens = Number(value)))}
      ${numberField("Max kontekst", config.ai.maxContextChars, (value) => (config.ai.maxContextChars = Number(value)))}
      ${numberField("Max istorija", config.ai.maxHistoryChars, (value) => (config.ai.maxHistoryChars = Number(value)))}
      ${numberField("Max slika", config.ai.maxImages, (value) => (config.ai.maxImages = Number(value)))}
      ${numberField("Temperatura", config.ai.temperature, (value) => (config.ai.temperature = Number(value)), 0, 0.35, 0.05)}
      ${checkboxField("Greska vodi na handoff", config.ai.fallbackToHumanOnError, (value) => (config.ai.fallbackToHumanOnError = value))}
      ${textArea("System prompt", config.ai.systemPrompt, (value) => (config.ai.systemPrompt = value), "full")}
    </div>`
  );

  panels.ai.insertAdjacentHTML(
    "beforeend",
    section(
      "Model routing",
      `<div class="grid">
        ${checkboxField("Automatski izbor modela", config.ai.modelRouting.enabled, (value) => (config.ai.modelRouting.enabled = value))}
        ${textField("Laka pitanja", config.ai.modelRouting.simpleModel, (value) => (config.ai.modelRouting.simpleModel = value))}
        ${textField("Srednja pitanja", config.ai.modelRouting.standardModel, (value) => (config.ai.modelRouting.standardModel = value))}
        ${textField("Zahtevna pitanja", config.ai.modelRouting.complexModel, (value) => (config.ai.modelRouting.complexModel = value))}
        ${textField("Slike", config.ai.modelRouting.visionModel, (value) => (config.ai.modelRouting.visionModel = value))}
        ${numberField("Srednji prag karaktera", config.ai.modelRouting.standardMinChars, (value) => (config.ai.modelRouting.standardMinChars = Number(value)))}
        ${numberField("Zahtevan prag karaktera", config.ai.modelRouting.complexMinChars, (value) => (config.ai.modelRouting.complexMinChars = Number(value)))}
        ${textField("Zahtevne reci", (config.ai.modelRouting.complexKeywords || []).join(", "), (value) => (config.ai.modelRouting.complexKeywords = splitCsv(value)), "full")}
      </div>`
    )
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
      body: JSON.stringify({ platformUserId, tenantId: currentTenantId })
    });
    conversations = await fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/conversations`);
    renderSidebar();
    setSaved(`Obrisano: ${result.deleted} / raw ${result.rawEventsDeleted}`, true);
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
      <label class="toggle-row full" for="testAllowAi">
        <input id="testAllowAi" type="checkbox" />
        <span>Koristi pravi AI fallback u testu</span>
      </label>
    </div>
    <div class="actions"><button id="runTest" class="primary">Testiraj</button></div>
    <div id="testResult" class="test-result"></div>`
  );

  panels.test.querySelector("#runTest").addEventListener("click", async () => {
    const result = await fetchJson("/api/test-message", {
      method: "POST",
      body: JSON.stringify({
        tenantId: currentTenantId,
        channelType: panels.test.querySelector("#testChannel").value,
        text: panels.test.querySelector("#testText").value,
        allowAi: panels.test.querySelector("#testAllowAi").checked
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
  const usage = tenantStore?.usageSummary || {};
  const activeChannels = config.channels.filter((channel) => channel.enabled).length;
  const rules = config.automation.rules.filter((rule) => rule.enabled).length;
  const faqs = config.automation.faqs.filter((faq) => faq.enabled).length;
  const knowledge = config.knowledge.documents.filter((document) => document.enabled).length;
  document.querySelector("#statusList").innerHTML = `
    <dt>Klijent</dt><dd>${escapeHtml(currentTenantId)}</dd>
    <dt>Kanali</dt><dd>${activeChannels}</dd>
    <dt>Pravila</dt><dd>${rules}</dd>
    <dt>FAQ</dt><dd>${faqs}</dd>
    <dt>Znanje</dt><dd>${knowledge}</dd>
    <dt>AI</dt><dd>${config.ai.enabled ? "on" : "off"}</dd>
    <dt>API usage</dt><dd>${usage.percentUsed || 0}%</dd>
    <dt>Orders</dt><dd>${tenantStore?.orders?.length || 0}</dd>
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
    config = await fetchJson(`/api/tenants/${encodeURIComponent(currentTenantId)}/config`, {
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

function activateTab(tab, options = {}) {
  if (!options.keepEditMode && (tab === "dashboard" || tab === "tenants")) {
    editingTenant = false;
    setEditMode(false);
  }

  document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  Object.entries(panels).forEach(([name, panel]) => panel.classList.toggle("active", name === tab));
  document.body.dataset.activeTab = tab;
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

function secretField(label, value, hasValue, setter, extraClass = "", id = "") {
  const inputId = id || `field-${Math.random().toString(16).slice(2)}`;
  queueBinder(inputId, setter, "value");
  const placeholder = hasValue ? "Sačuvano - nalepi novu vrednost samo ako menjas" : "";
  return `<div class="field ${extraClass}">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <input id="${inputId}" type="password" autocomplete="off" spellcheck="false" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(placeholder)}" />
    <small>${hasValue ? "Token je sačuvan šifrovano za ovog klijenta." : "Vrednost se čuva šifrovano i ne prikazuje se klijentima."}</small>
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
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
  }
  return response.json();
}

function normalizeClientConfig(value) {
  const normalized = structuredClone(value || {});
  normalized.business ||= {};
  normalized.meta ||= {};
  normalized.meta.appSecretValue ||= "";
  normalized.meta.pageAccessTokenValue ||= "";
  normalized.channels ||= [];
  normalized.channels = normalized.channels.map((channel) => ({
    ...channel,
    pageAccessTokenValue: channel.pageAccessTokenValue || ""
  }));
  normalized.automation ||= {};
  normalized.automation.rules ||= [];
  normalized.automation.faqs ||= [];
  normalized.automation.collectFields ||= [];
  normalized.automation.handoffKeywords ||= [];
  normalized.automation.riskyKeywords ||= [];
  normalized.knowledge ||= {};
  normalized.knowledge.documents ||= [];
  normalized.ai ||= {};
  normalized.ai.model ||= "gpt-5.5";
  normalized.ai.apiKeyEnv ||= "OPENAI_API_KEY";
  normalized.ai.maxInputChars ||= 1800;
  normalized.ai.maxOutputTokens ||= 320;
  normalized.ai.maxContextChars ||= 2600;
  normalized.ai.maxHistoryChars ||= 900;
  normalized.ai.maxImages ||= 2;
  normalized.ai.temperature ??= 0.15;
  normalized.ai.modelRouting ||= {};
  normalized.ai.modelRouting.standardMinChars ||= 280;
  normalized.ai.modelRouting.complexMinChars ||= 1200;
  normalized.ai.modelRouting.complexKeywords ||= [];
  normalized.handoff ||= {};
  normalized.handoff.ticketing ||= {};
  normalized.privacy ||= {};
  normalized.catalog ||= {};
  normalized.catalog.sourceUrl ||= "";
  normalized.catalog.refreshEveryHours ||= 24;
  normalized.usage ||= {};
  normalized.usage.monthlyLimitUsd ||= 20;
  normalized.integrations ||= {};
  normalized.integrations.googleSheets ||= {};
  normalized.integrations.googleSheets.webhookUrlEnv ||= "";
  normalized.integrations.googleSheets.webhookUrl ||= "";
  normalized.integrations.googleSheets.sheetUrl ||= "";
  return normalized;
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

function formatMoney(value) {
  const number = Number(value || 0);
  return `$${number.toFixed(number >= 10 ? 2 : 4)}`;
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
