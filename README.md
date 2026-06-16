# Meta Bot MVP

Konfigurabilan MVP za Facebook Messenger i Instagram Direct bota. Projekat ima jedan Node servis koji prima Meta webhook, proverava token/potpis, vodi poruku kroz pravila, FAQ, opciono AI fallback i human handoff, a admin panel omogucava korisniku da sam podesava ponasanje bota.

## Pokretanje

1. Kopiraj `.env.example` u `.env` i popuni vrednosti koje imas.
2. Pokreni:

```powershell
npm start
```

3. Otvori `http://localhost:3000`.

Nema obaveznih npm dependency-ja za prvi MVP. Potreban je Node 20+; za produkciju i CI koristi se Node 24.
Servis sam ucitava `.env` fajl iz korena projekta, a vrednosti koje su vec postavljene u sistemskom okruzenju imaju prednost.

Ako konzolu izlozis preko javnog tunela, obavezno postavi `ADMIN_TOKEN`. Van localhost-a admin panel i `/api/*` rute su zakljucani Basic/Bearer autentifikacijom.

## Sta je ukljuceno

- `GET /webhook` za Meta verify handshake.
- `POST /webhook` za Messenger/Instagram dogadjaje.
- `X-Hub-Signature-256` provera kada je ukljucena u podesavanjima.
- Admin autentifikacija preko `ADMIN_TOKEN` za javno izlozenu konzolu.
- Deduplikacija Meta event ID-jeva da retry ne napravi duple odgovore.
- Blokada automatskog slanja kada je webhook dogadjaj stariji od Meta 24h prozora.
- Serijski webhook queue za lokalni JSON storage, da paralelni retry zahtevi ne pregaze razgovore.
- `/api/readiness` i `/api/metrics` iza admin autentifikacije.
- Admin panel za poslovne podatke, kanale, pravila, FAQ, lead capture, AI, handoff i privacy.
- Test simulator poruke bez slanja na Meta API.
- Lokalni JSON storage za konfiguraciju i razgovore.
- Lokalna baza znanja pre AI fallback-a.
- ChatGPT/OpenAI AI fallback preko `OPENAI_API_KEY`, ukljucujuci razumevanje slika iz Messenger/Instagram poruka.
- Opcioni Gemini fallback preko `GEMINI_API_KEY`.
- Opcioni ticketing webhook preko `TICKETING_WEBHOOK_URL`.

## Meta podesavanja

Webhook URL za lokalni razvoj mora biti javno dostupan preko tunela, na primer ngrok ili Cloudflare Tunnel:

```text
https://tvoj-tunel.example/webhook
```

U Meta App Dashboard-u koristi isti verify token kao `META_VERIFY_TOKEN`. Za produkciju ostavi signature proveru ukljucenu i postavi `META_REQUIRE_SIGNATURE=true`.
Ako koristis tunel za lokalni razvoj, postavi i `ADMIN_TOKEN`, jer je admin konzola na istom servisu kao webhook.

Minimalne dozvole za Messenger MVP:

- `pages_show_list`
- `pages_manage_metadata`
- `pages_messaging`

Za Instagram Direct preko Page-linked naloga:

- `instagram_basic`
- `instagram_manage_messages`
- `pages_manage_metadata`

## ChatGPT/OpenAI AI podesavanja

Podrazumevani AI provider je OpenAI. U `.env` postavi:

```text
OPENAI_API_KEY=tvoj-openai-api-key
```

U admin panelu otvori tab `AI`, proveri da je provider `openai`, i ostavi `Greska vodi na handoff` ukljuceno za sigurniji rad. Kada korisnik posalje sliku, bot preuzima sliku iz Meta attachment URL-a, salje je OpenAI Responses API-ju kao multimodalni input i odgovara u okviru Meta 24h prozora.

Model routing je ukljucen podrazumevano:

- Laka pitanja: `gpt-5.4-nano`
- Srednja pitanja: `gpt-5.4-mini`
- Zahtevna pitanja: `gpt-5.5`
- Poruke sa slikama: `gpt-5.5`

Router gleda duzinu poruke, broj pitanja, broj pronadjenih izvora iz baze znanja i reci kao sto su `analiziraj`, `strategija`, `uporedi`, `problem`, `kod`, `ugovor` i `reklamacija`. Ako iskljucis automatski izbor modela u admin panelu, koristi se glavni model iz polja `Model`.

## SaaS shop bot sloj

Servis sada ima master panel i odvojeni client portal:

- Master: `http://localhost:3000`
- Client portal: `http://localhost:3000/client.html`
- Tenant webhook: `http://localhost:3000/webhook/{tenantId}`

Svaki klijent ima svoj config, kanale, catalog URL, knowledge bazu, AI key env, usage limit, Google Sheet webhook i odvojene razgovore/narudzbine. U client portalu klijent moze da unese URL shopa i pokrene sync; crawler izvlaci proizvode, cene, slike i politike dostave/zamene/reklamacija iz sajta i pretvara ih u knowledge dokumente. Bot je podesen da koristi sajt kao izvor istine i da ne izmislja cene, rokove, dostavu ili dostupnost.

Commerce sloj prepoznaje:

- cenu i pitanja o proizvodima
- narudzbine i nedostajuce podatke
- boju, model, varijantu i kolicinu kada ih korisnik napise
- cenu dostave
- rok izrade/slanja
- zamenu
- reklamaciju
- kasnjenje posiljke

Za porudzbine bot vodi korisnika recenicom “Ukoliko zelite da porucite, ostavite podatke” i trazi samo ono sto fali: ime i prezime, telefon, ulica i broj, grad, postanski broj i proizvod/model/boju. Kada su podaci spremni, zapisuje order record i opciono salje u Google Sheet preko Apps Script webhook URL-a.

Za produkcioni deploy koristi `db/schema.sql` kao Postgres/Neon osnovu. Lokalni MVP i dalje cuva runtime podatke u `data/tenants/*.store.json`, sto olaksava razvoj bez cloud baze.

## Produkcioni sledeci koraci

Ovaj MVP namerno koristi JSON fajlove da bi se brzo proverio tok. Za produkciju prebaci storage na PostgreSQL, dodaj Redis queue za asinhronu obradu, uvedi Secret Manager za tokene i napravi posebne dev/stage/prod Meta aplikacije.

Pre javnog pustanja proveri:

```powershell
Invoke-RestMethod http://localhost:3000/api/readiness -Headers @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
```

`ready` treba da bude `true`. Ako nije, endpoint vraca tacne stavke koje nedostaju.

## Docker

```powershell
docker build -t metabot .
docker run --env-file .env -p 3000:3000 metabot
```

Za trajnu produkciju mountuj `data/` ili zameni JSON storage bazom.
