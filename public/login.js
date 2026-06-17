const form = document.querySelector("#unifiedLoginForm");
const status = document.querySelector("#loginStatus");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Proveravam pristup...";

  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const password = String(data.get("password") || "");

  if (!username || !password) {
    status.textContent = "Unesite email/username i sifru.";
    return;
  }

  if (username.toLowerCase() === "admin") {
    const response = await fetch("/auth/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    if (response.ok) {
      window.location.href = "/admin.html";
      return;
    }
  } else {
    const response = await fetch("/client-api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: username, password })
    });

    if (response.ok) {
      const result = await response.json();
      localStorage.setItem("metabot-client-session", JSON.stringify({ tenantId: result.tenant.id, token: result.token }));
      window.location.href = `/client.html?tenant=${encodeURIComponent(result.tenant.id)}`;
      return;
    }
  }

  status.textContent = "Login nije ispravan ili nalog jos nije odobren.";
});
