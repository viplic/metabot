document.querySelector("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#signupStatus");
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.name = String(payload.name || "").trim();
  payload.ownerEmail = String(payload.ownerEmail || "").trim();
  payload.niche = String(payload.niche || "").trim();
  if (payload.password !== payload.passwordConfirm) {
    status.textContent = "Lozinke se ne poklapaju.";
    return;
  }
  if (String(payload.password || "").length < 8) {
    status.textContent = "Lozinka mora imati najmanje 8 karaktera.";
    return;
  }
  delete payload.passwordConfirm;
  status.textContent = "Saljem zahtev...";
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/client-api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(signupErrorMessage(result, response.status));
    event.currentTarget.reset();
    status.textContent = "Zahtev je poslat. Kada admin odobri nalog, logujes se emailom/ID-em i lozinkom koju si uneo.";
  } catch (error) {
    status.textContent = error.message || "Nije uspelo slanje zahteva. Pokusajte ponovo.";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

function signupErrorMessage(result, statusCode) {
  const code = result?.error || result?.code;
  if (code === "invalid_email") return "Email adresa nije ispravna.";
  if (code === "weak_password") return "Lozinka mora imati najmanje 8 karaktera.";
  if (code === "rate_limited" || statusCode === 429) return "Previse pokusaja. Sacekajte minut pa pokusajte ponovo.";
  if (result?.message) return result.message;
  return "Nije uspelo slanje zahteva. Proverite podatke i pokusajte ponovo.";
}
