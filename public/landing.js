document.querySelector("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#signupStatus");
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
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
  try {
    const response = await fetch("/client-api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("signup_failed");
    event.currentTarget.reset();
    status.textContent = "Zahtev je poslat. Kada admin odobri nalog, logujes se emailom/ID-em i lozinkom koju si uneo.";
  } catch {
    status.textContent = "Nije uspelo slanje zahteva. Pokusajte ponovo.";
  }
});
