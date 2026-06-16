document.querySelector("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#signupStatus");
  const form = new FormData(event.currentTarget);
  status.textContent = "Saljem zahtev...";
  try {
    const response = await fetch("/client-api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    if (!response.ok) throw new Error("signup_failed");
    event.currentTarget.reset();
    status.textContent = "Zahtev je poslat. Admin mora da odobri nalog pre login-a.";
  } catch {
    status.textContent = "Nije uspelo slanje zahteva. Pokusajte ponovo.";
  }
});
