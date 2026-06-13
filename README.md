# Meta Bot MVP

Konfigurabilan MVP za Facebook Messenger i Instagram Direct bota. Projekat ima jedan Node servis koji prima Meta webhook, proverava token/potpis, vodi poruku kroz pravila, FAQ, opciono AI fallback i human handoff, a admin panel omogucava korisniku da sam podesava ponasanje bota.

## Pokretanje

1. Kopiraj `.env.example` u `.env` i popuni vrednosti koje imas.
2. Pokreni:

```powershell
npm start
```

3. Otvori `http://localhost:3000`.

Nema obaveznih npm dependency-ja za prvi MVP. Potreban je Node 20+.

## Sta je ukljuceno

- `GET /webhook` za Meta verify handshake.
- `POST /webhook` za Messenger/Instagram dogadjaje.
- `X-Hub-Signature-256` provera kada je ukljucena u podesavanjima.
- Admin panel za poslovne podatke, kanale, pravila, FAQ, lead capture, AI, handoff i privacy.
- Test simulator poruke bez slanja na Meta API.
- Lokalni JSON storage za konfiguraciju i razgovore.
- Opcioni OpenAI fallback preko `OPENAI_API_KEY`.
- Opcioni ticketing webhook preko `TICKETING_WEBHOOK_URL`.

## Meta podesavanja

Webhook URL za lokalni razvoj mora biti javno dostupan preko tunela, na primer ngrok ili Cloudflare Tunnel:

```text
https://tvoj-tunel.example/webhook
```

U Meta App Dashboard-u koristi isti verify token kao `META_VERIFY_TOKEN`. Za produkciju ukljuci signature proveru i postavi `META_REQUIRE_SIGNATURE=true`.

Minimalne dozvole za Messenger MVP:

- `pages_show_list`
- `pages_manage_metadata`
- `pages_messaging`

Za Instagram Direct preko Page-linked naloga:

- `instagram_basic`
- `instagram_manage_messages`
- `pages_manage_metadata`

## Produkcioni sledeci koraci

Ovaj MVP namerno koristi JSON fajlove da bi se brzo proverio tok. Za produkciju prebaci storage na PostgreSQL, dodaj Redis queue za asinhronu obradu, uvedi Secret Manager za tokene i napravi posebne dev/stage/prod Meta aplikacije.
