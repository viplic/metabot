# Analitički izveštaj o pravljenju chatbota za Facebook Messenger i Instagram

> **Napomena o verzijama:** Sve verzije softvera i cene verifikovane 13. juna 2026. Ekosistem se brzo menja — preporučuje se provera aktuelnosti pre implementacije.

---

## Izvršni rezime

Za slučaj u kome želite bota koji automatski odgovara klijentima na Facebook Messengeru i Instagram Direct-u, najpraktičnija i najotpornija arhitektura je webhook-first sistem: Meta šalje događaje u realnom vremenu, backend proverava potpis i pravila prozora za dopisivanje, zatim poruku vodi kroz slojeve pravila → baza znanja/RAG → LLM fallback, a kada je potrebna ljudska podrška, prebacuje razgovor na agenta kroz Conversation Routing i/ili human_agent režim. Messenger Platform pokriva Page razgovore i Page-linked Instagram razgovore, dok je za Instagram dostupan i noviji tok sa Instagram Login, uključujući Messaging API za profesionalne naloge.

Ako je sistem greenfield i budžet nije definisan, preporuka je da MVP bude jedan servis za webhook i slanje poruka, jedna relacijska baza kao izvor istine, Redis za keš/redove/rate-limit state, i jedan jasan model odlučivanja: pravila za jednostavne odgovore, baza znanja za FAQ, a generativni model samo za dvosmislene i složenije upite. To umanjuje trošak, smanjuje pravne i bezbednosne rizike i olakšava audit trail. Za Messenger i Instagram Meta zvanično podstiče webhook pristup radi real-time obrade i manjeg oslanjanja na često pozivanje API-ja, a dugotrajni problemi sa webhook endpointom mogu dovesti i do automatskog odjavljivanja webhook pretplate.

Najvažniji nefunkcionalni zahtevi nisu "AI" nego autentifikacija, dozvole, Live Mode/App Review, usklađenost sa Meta politikama i GDPR, kao i robusno upravljanje tokenima. Za produkciju treba očekivati: Live Mode, odgovarajuće permissions i često Advanced Access, javno dostupnu privacy policy stranicu, data deletion callback/URL, godišnje procese obnovljene usklađenosti kroz Meta Data Access Renewal/Data Use Checkup, kao i interni GDPR režim za pravni osnov, transparentnost, minimizaciju, rokove čuvanja i brisanje.

Preporučeni stek za novu implementaciju je: Graph API v25.0, Node.js 24.16.0 LTS ili Python 3.13.x za produkciju, TypeScript 6.0 (objavljen 23. marta 2026. — poslednja JS-bazirana verzija kompilatora; TypeScript 7.0 donosi rewrite u Go), Express 5.1.0 ili Fastify 5.8.x na Node strani, ili FastAPI 0.136.3 na Python strani; za bazu PostgreSQL 18 uz pgvector 0.8.2; za keš i radne redove Redis 8.8.0 (pod AGPLv3, RSALv2 ili SSPLv1) ili Valkey (BSD licenca, Linux Foundation fork, preporučen za enterprise okruženja sa strogim open-source zahtevima); za LLM sloj OpenAI JS SDK 6.42.0 ili OpenAI Python SDK 2.41.1. Ako želite self-hosted opciju, vredi razmotriti vLLM stable liniju ili lokalni razvoj uz Ollama, uz pažljiv izbor modela za srpski i evaluaciju kvaliteta.

Budžet ostaje neodređeno bez ulaznih podataka o volumenu poruka, postojećim integracijama i zahtevima za ljudsku podršku, ali se mogu dati razumne procene. Sam API trošak modela može biti veoma nizak ako se bot ne oslanja na model za svaku poruku: uz pretpostavku od oko 1.000 ulaznih i 300 izlaznih tokena po jednoj složenijoj obradi, GPT-4o izlazi približno $0,0055 po obradi, odnosno oko $55 za 10.000 obrada mesečno, dok bi GPT-4o mini pod istom pretpostavkom bio oko $3,3 za 10.000 obrada; embeddings su još jeftiniji i za text-embedding-3-large iznose $0,13 / 1M tokena (ili $0,065 / 1M tokena uz OpenAI Batch API, koji nudi 50% popust za asinhrone workload-ove).

---

## Poslovni opseg i minimalni MVP

Vaša tri primarna cilja su sasvim ispravna i tehnički ostvariva u okviru Meta kanala: automatski odgovori, preusmeravanje na ljudsku podršku i prikupljanje relevantnih podataka. Meta platforma za poslovno dopisivanje podržava real-time poruke na Messengeru i Instagramu, a za Instagram postoje i prateći API-ji za dohvat korisničkog profila, razgovora, poruka i routing ka ljudskom agentu. Međutim, prikupljanje podataka mora biti strogo vezano za svrhu podrške ili prodajnog toka, uz jasnu transparentnost i rok čuvanja, u skladu sa GDPR načelima minimizacije i ograničenja svrhe.

**Napomena za tim podrške:** Meta je ugasila standalone Messenger desktop aplikacije i preselila sve korisnike messenger.com na Facebook-ovu glavnu platformu. Agenti koji su koristili desktop Messenger klijent za preuzimanje razgovora moraju preći na inbox u Facebook Business Suite, treću aplikaciju ili API-integrisani helpdesk alat.

Za minimalni MVP preporučujem da obuhvati samo ono što donosi neposrednu poslovnu vrednost i najmanje regulatornog rizika:

- automatski odgovor na novu poruku i osnovni greeting po kanalu,
- FAQ tokove za radno vreme, lokaciju, cenu/uslugu, status porudžbine ili zakazivanje,
- prikupljanje jednog do tri ključna podatka po razgovoru, na primer ime, kontakt i tema upita,
- prepoznavanje "human handoff" okidača,
- ručno preuzimanje niti od strane agenta,
- osnovnu analitiku: broj razgovora, stopa automatskog razrešenja, vreme do prvog odgovora, broj eskalacija,
- privacy notice link i mehanizam za brisanje podataka.

Ovo je dovoljno da validirate kanal, proces i ekonomiju automatizacije bez preuranjene izgradnje složenog "AI asistenta".

Podržane platforme treba razlikovati ovako. Ako želite jedinstveniji operativni model za Messenger i Instagram, najjednostavniji put je Facebook Page + Messenger Platform + Instagram Professional nalog povezan sa tom Page; Meta eksplicitno dokumentuje "Messenger API support for Instagram" za ovaj scenario. Ako Instagram nalog nije povezan sa Facebook Page, Meta navodi da možete koristiti Instagram API with Instagram Login i njegov Messaging API. To znači da odluka o onboarding toku zavisi od vašeg naloga i budućeg modela širenja na druge klijente.

Praktično, za početak bih preporučio sledeći opseg:

- MVP kanal: jedan Messenger nalog i jedan Page-linked Instagram nalog,
- MVP tipovi odgovora: tekst i link; mediju ostaviti za fazu hardening-a,
- MVP integracije: CRM ili ticketing samo ako već postoji proces koji morate da zadržite,
- MVP AI: bez fine-tuninga, sa pravilima i RAG-om kao prvim odgovorom, a LLM samo kao fallback.

To smanjuje rizik od skupog i pravno neurednog "LLM-first" rešenja.

---

## Autentifikacija, dozvole i usklađenost

### Tok autentifikacije i permission model

Za produkcionu integraciju potrebno je da napravite Meta App, podesite odgovarajuće proizvode, dodate webhook endpoint, a zatim kroz Meta onboarding dobijete potrebne tokene. Meta dokumentuje da se Page Access Token dobija tako što se najpre dobije User Access Token, pa se on zameni za Page Access Token. Za Instagram su danas relevantna dva toka: Instagram API with Facebook Login i Instagram API with Instagram Login, pri čemu drugi uklanja obavezni Facebook login iz onboarding procesa za Instagram profesionalne naloge.

Za Messenger MVP, minimalni praktični skup dozvola je obično:

- `pages_show_list` za odabir i dobijanje Page ID-ja,
- `pages_manage_metadata` za webhook pretplate i Page settings,
- `pages_messaging` za upravljanje razgovorima i porukama.

Meta eksplicitno navodi `pages_show_list` za dobijanje Page ID-ja, `pages_manage_metadata` za webhook/subscription tokove i `pages_messaging` za rad nad razgovorima.

Za Instagram Direct u Page-linked scenariju, minimalni praktični skup dozvola je obično:

- `instagram_basic`,
- `instagram_manage_messages`,
- `pages_manage_metadata`.

Meta u Instagram Messaging onboarding dokumentu eksplicitno navodi ova odobrenja, a Conversations API za Instagram potvrđuje `instagram_basic`, `instagram_manage_messages` i `pages_manage_metadata`. Ako planirate upload/razmenu medija, proverite i dodatne zavisnosti kao što je `pages_messaging`, jer Meta za upload medija navodi i taj permission.

Za aplikacije koje rade sa realnim korisnicima, a ne samo sa vlasnikom aplikacije i testerima, treba računati na Live Mode i često na Advanced Access/App Review. Meta je odvojeno dokumentovala da su Dev Mode aplikacije ograničene na ljude povezane sa aplikacijom kroz role/testere, a produkcija zahteva Live Mode. Za Conversations API i slične tokove Meta eksplicitno navodi da je Advanced Access potreban da biste pristupali razgovorima sa ljudima koji nemaju rolu na aplikaciji.

Za bezbednost server-side poziva obavezno uključite:

- proveru `X-Hub-Signature-256` na svim webhook POST pozivima,
- proveru `hub.verify_token` u GET handshake-u,
- `appsecret_proof` pri Graph API pozivima gde je to primenljivo,
- enkriptovano skladištenje access tokena i rotaciju.

Meta zvanično dokumentuje i verify token handshake i SHA-256 potpis webhook payload-a, kao i preporuku za `appsecret_proof` kod server-to-server poziva.

### Meta politike i GDPR

Najvažnije poslovno ograničenje na Meta kanalima je standardni 24-časovni prozor za odgovor. Meta za Messenger i Instagram navodi da biznis ima do 24 sata da odgovori na korisnikovu poruku, a ako je potrebno više vremena za čoveka, može se koristiti Human Agent mogućnost, koja omogućava ručni odgovor do 7 dana od korisnikove poruke. To znači da vaš bot mora da vodi strogu evidenciju o `last_user_message_at`, da zna kada je dozvoljen automatski odgovor, a kada sme samo da preda nit čoveku ili da prekine automatizaciju.

Za "handoff" arhitekturu, nemojte zasnivati novi sistem na starom Messenger Handover Protocol modelu. Meta je dokumentovala da je Messenger prešao na **Conversation Routing** (Handover Protocol je zvanično deprecated i sve integracije su migrisane), a za Instagram postoji istoimeni routing model i Conversation Control API-ji za predaju niti drugoj aplikaciji ili inbox-u. Conversation Routing je dizajniran da bude backwards-kompatibilan sa Handover Protocol API-jima, ali se nova arhitektura mora planirati oko njega. Ako vam je važna ozbiljna ljudska podrška, ovo treba projektovati kao first-class capability, ne kao naknadni "escape hatch".

Sa GDPR strane, operativni minimum izgleda ovako:

- pravni osnov po članu 6 za obradu, tipično ugovorni odnos ili legitimni interes za korisničku podršku, ali ovo treba pravno potvrditi za vaš konkretan proces,
- transparentnost iz člana 13: ko ste, zašto obrađujete podatke, koliko dugo ih čuvate, da li koristite automatizaciju, kako se traži pristup/brisanje,
- poštovanje načela iz člana 5: minimizacija, ograničenje svrhe i roka čuvanja,
- brisanje bez nepotrebnog odlaganja kad postoji obaveza ili zahtev iz člana 17,
- oprez sa potpuno automatizovanim odlukama koje proizvode pravne ili slično značajne efekte, zbog člana 22.

U Meta App Dashboard-u pre objave treba obavezno postaviti privacy policy i data deletion callback/url, a posle puštanja u rad računati na godišnje procese kao što su Data Access Renewal i Data Use Checkup, dok deo aplikacija sa pristupom određenim vrstama platformskih podataka može imati i dodatne godišnje procene zaštite podataka.

Operativno-pravna preporuka je zato jasna: bot sme da automatizuje podršku, kvalifikaciju lead-a i prikupljanje osnovnih podataka, ali ne sme bez ljudskog pregleda da donosi odluke tipa odbijanje reklamacije, odbijanje prava korisnika, naplata, procena kreditne sposobnosti ili slične odluke sa ozbiljnim posledicama.

---

## Arhitektura i preporučeni tehnološki stek

### Preporučeni stek i verzije

*(Sve verzije verifikovane: 13. jun 2026.)*

| Sloj | Primarna preporuka | Verzija ili status |
|---|---|---|
| Meta API | Graph API pinovan po verziji | v25.0 (objavljen 18. februara 2026.) |
| Node runtime | produkcija na LTS liniji | Node.js 24.16.0 LTS (objavljen 21. maja 2026.) |
| TypeScript | preporučeno za Node backend | TypeScript 6.0 (objavljen 23. marta 2026.; poslednja JS-bazirana verzija; 7.0 donosi Go kompilator) |
| Node web framework | Express za brz start; Fastify za veći throughput | Express 5.1.0; Fastify latest v5.8.x |
| Python runtime | produkcija | Python 3.13.x kao stabilna linija |
| Python web framework | webhook/API servis | FastAPI 0.136.3 |
| Alternativni Python framework | ako želite klasičan web stack | Flask 3.1.3; Django 6.0.x |
| ORM / data access | Node | Prisma ORM 7.7.0 |
| SQL baza | izvor istine | PostgreSQL 18 (objavljen sep. 2025.) |
| Vector ekstenzija | RAG i semantička pretraga | pgvector 0.8.2 (minimum zbog CVE-2026-3172, CVSS 8.1) |
| Cache / queue / limiter | Redis ili Valkey | Redis Open Source 8.8.0 (AGPLv3/RSALv2/SSPLv1 — vidi napomenu); **Valkey** (BSD licenca, Linux Foundation fork — preporučen za enterprise) |
| OpenAI JS SDK | ako koristite GPT-4o / embeddings | openai 6.42.0 |
| OpenAI Python SDK | isto za Python | openai 2.41.1 |

**Napomena o Redis / Valkey licenci:** Redis 8+ je dostupan pod tri licence: RSALv2, SSPLv1 i **AGPLv3** (OSI-odobrena). Za standardnu internu upotrebu (nije managed service koji prodajete trećima) AGPLv3 je slobodan i open-source. Međutim, ako vaša organizacija ima stroge politike prema copyleft licencama ili planirate integraciju u SaaS koji distribuirate, preporučuje se **Valkey** — BSD-licencirani fork Redis 7.2.4 koji održava Linux Foundation, pokrenut upravo kao odgovor na licencne promene Redis-a.

Ovaj stek je namerno konzervativan: za produkciju biram LTS/runtime stabilnost pre "najnovijeg po svaku cenu", dok API-je i dependency-je koji su direktno vezani za Meta i AI pinujem po verziji da bi rollback i regresiona testiranja bila predvidljiva. Meta dokumentuje da novi Graph API release izlazi po verzijama i da stare verzije vremenom ističu; zato u kodu treba koristiti eksplicitne `/v25.0/...` putanje i ubaciti kalendarski podsetnik za upgrade testove pre isteka podrške.

Ako želite Node arhitekturu sa više strukture i DI-a, NestJS 11 je razumna opcija, tim pre što zvanična dokumentacija navodi da sa ovom verzijom Express v5 postaje podrazumevana integracija. Ako želite čist webhook/API servis uz minimalan overhead, Express ili Fastify su jednostavniji.

### Preporučena arhitektura sistema

Suština arhitekture je sledeća: Meta webhook prima događaje, backend proverava potpis i normalizuje payload, zatim poruku zapisuje kao immutable događaj, izvlači poslovni kontekst iz Postgresa/CRM-a, proverava prozor za slanje i routing pravila, odgovara automatski ili otvara handoff. Generativni model nije "centar sistema"; centar sistema je state machine razgovora sa jasnim pravilima, audit tragom i fallback-ovima. Ovo je posebno važno zbog 24h prozora, Human Agent režima, rate limit-a i GDPR auditability-a.

---

## Baza podataka i šeme

Za ovakav sistem bih kao podrazumevani izbor uzeo PostgreSQL 18 + pgvector 0.8.2, i to iz tri razloga: razgovori imaju prirodno relacione veze, potreban je audit i referencijalni integritet, a pgvector omogućava da u istoj bazi držite i poslovne podatke i vektorske indekse za pretragu znanja. Dodatno, pgvector 0.8.2 je važan minimum zbog bezbednosne ispravke za CVE-2026-3172 — buffer overflow u parallel HNSW index build-u koji može izložiti osetljive podatke iz baze ili izazvati crash PostgreSQL servera (CVSS 8.1, High). Sve verzije 0.6.0–0.8.1 su ranjive.

| Opcija | Kada ima smisla | Prednosti | Mane | Preporuka |
|---|---|---|---|---|
| PostgreSQL + pgvector | gotovo svi botovi koji imaju state, audit i integracije | ACID, zrelo SQL modelovanje, dobra analitika, jedan "source of truth", vektorska pretraga u istoj bazi | treba pažljivo indeksirati i modelovati šemu | **Primarni izbor** |
| MongoDB | ako imate izrazito nestrukturisane događaje i brz razvoj dokument modela | fleksibilna šema, dobar fit za event payload-e | slabiji relacijski audit model kao primarni izvor istine za support tokove | Sekundarno ili pomoćno |
| Redis / Valkey | za keš, rate limiting, deduplikaciju, redove i kratkotrajni state | vrlo brz, odličan za limiter i queue state | ne koristiti kao kanonski storage razgovora | **Obavezna pomoćna komponenta** |

Praktična šema podataka treba da sadrži najmanje sledeće entitete: `channel_accounts`, `customers`, `conversations`, `messages`, `intent_events`, `handoff_tickets`, `knowledge_documents`, `knowledge_chunks`, `audit_events`. Ako trenutno nemate CRM, vredno je ipak odmah napraviti `customers` i `conversation_summary` sloj, da kasnije ne radite bolne migracije.

---

## NLP, modeli i integracije

### Kako treba da izgleda NLP sloj

Za poslovni bot na srpskom i regionalnom tržištu preporučujem hibridni NLP sloj, redosledom:

1. pravila i ključne reči za visoko-predvidive tokove,
2. intent recognition + retrieval za FAQ i dokumentovano znanje,
3. LLM fallback samo kada prva dva sloja nisu dovoljna,
4. human handoff kada je pouzdanje nisko, zahtev je rizičan ili traži radnju van definisanih ovlašćenja.

Ovakav raspored je praktično superioran nad "LLM odgovara na sve", jer je jeftiniji, lakše testabilan, pravno čistiji i manje sklon halucinacijama.

Ako koristite OpenAI, dobra podela posla izgleda ovako:

- `text-embedding-3-large` za semantičku pretragu i RAG nad dokumentima, jer OpenAI navodi da je to njihov najjači embedding model za english i non-english zadatke, sa podrazumevanom dimenzijom 3072,
- `gpt-4o-mini` za klasifikaciju, sažimanje i jeftinije generisanje,
- `gpt-4o` za složenije višekorake, nejasne upite i kvalitetniji fallback.

OpenAI Responses API je danas preporučljiv interfejs jer zvanično podržava stateful interakcije i tool calling. Assistants API je zakazan za sunset u 2026, što Responses API čini jedinom dugoročnom opcijom za agentic workflow-e.

Fine-tuning nije prvi korak. Po OpenAI dokumentaciji i best practices smernicama, fine-tuning je najkorisniji kada želite da model pouzdanije prati stil, format, bezbednosna pravila ili specifične obrasce ponašanja. Za često promenljivo poslovno znanje — cene, dostupnost, politika povrata, aktuelni status porudžbina — bolji izbor je RAG nad svežim izvorima podataka, a ne fine-tuning. Ukratko: RAG za istinu, fine-tuning za ponašanje.

### Poređenje NLP rešenja

| Rešenje | Prednosti | Rizici / ograničenja | Kada ga koristiti |
|---|---|---|---|
| Pravila + regex + šabloni | najjeftinije, potpuno kontrolisano, lako za audit | slabo se nosi sa varijacijama jezika | greeting, radno vreme, lokacija, statusne poruke |
| Embeddings + RAG | dobro za FAQ, dokumenta i promene znanja bez retreninga | traži dobru bazu znanja i evaluaciju retrieva | većina support pitanja |
| GPT-4o mini / GPT-4o API | visoka fleksibilnost, bolji NLU i generisanje | trošak, potreba za guardrails, moguća halucinacija | fallback, složene poruke, parafraza i strukturisani izlazi |
| Self-hosted open-source LLM | veća kontrola nad podacima, "AI sovereignty", moguće niži varijabilni trošak | infra i MLOps složenost, kvalitet za srpski mnogo zavisi od modela | regulated ili high-volume okruženja |

Za srpski jezik i regionalni miks, self-hosted put treba birati pažljivo. Qwen3 zvanično navodi podršku za 100+ jezika i dijalekata, što ga čini atraktivnim kandidatom za multilingual support. Llama 3.3 je jak model, ali Meta i Ollama dokumentacija navode ograničen skup eksplicitno podržanih jezika bez srpskog, pa ga za srpski ne bih uzimao kao prvi izbor bez internog benchmark-a. Mistral Small 3.1 i noviji Mistral modeli imaju jak evropski/multilingual profil i dobar su kandidat za evaluaciju. Za serving su razumna rešenja vLLM i Ollama; vLLM dokumentuje OpenAI-kompatibilan API server.

### Integracije

Za CRM i ticketing integracije preporuka je da ne mešate channel logiku sa spoljnim sistemima, nego da uvedete adapter sloj i event-based sinhronizaciju. Najpraktičniji kandidati su:

- HubSpot CRM za lead/contact sinhronizaciju,
- Zendesk za otvaranje i praćenje tiketa,
- Salesforce REST API za enterprise CRM tokove,
- Stripe Checkout za opcioni payment flow.

Stripe treba integrisati kao checkout link/session iz poruke, a ne kao prikupljanje kartičnih podataka u četu. To pojednostavljuje usklađenost i smanjuje sigurnosni teret.

---

## Operacije, sigurnost, testiranje i deployment

### Skalabilnost, monitoring i logging

Skalabilnost za ovakav bot ne dobija se "jačim modelom", nego razdvajanjem sistema na:

- ingress webhook servis,
- queue/worker sloj,
- business logic i integracije,
- observability sloj.

Incoming događaje treba prvo upisati kao raw event i poslati u red za asinhronu obradu; to omogućava retry, dead-letter queue i zaštitu od šiljaka. Pošto Meta za Instagram dokumentuje konkretne rate limit-e, a Graph API i šire poslovne limite, webhook + queue pristup je važan i za stabilnost i za poštovanje limita.

Za observability je preporučena kombinacija OpenTelemetry + Prometheus + Grafana.

Najvažnije metrike koje treba pratiti nisu samo tehničke nego i poslovne:

- uspešnost webhook prijema,
- stopa verifikacionih i signature grešaka,
- p50/p95 vreme do prvog odgovora,
- stopa automatskog razrešenja,
- stopa handoff-a,
- broj razgovora po intentu i kanalu,
- "knowledge miss rate",
- stopa ponovnog otvaranja razgovora u 24h,
- CSAT/NPS ako ga uvedete,
- trošak po razgovoru i po razrešenom zahtevu.

### Sigurnost

Bezbednosni minimum za produkciju treba da uključuje sledeće:

- verifikaciju `X-Hub-Signature-256` za svaki webhook POST,
- `hub.verify_token` proveru na GET handshake-u,
- `appsecret_proof` za server-to-server Graph pozive,
- strogu validaciju inputa, limit veličine payload-a i sanitizaciju HTML/URL vrednosti,
- redakciju PII iz logova,
- enkripciju tokena "at rest" i Secret Manager/Vault skladištenje,
- rate limiting po korisniku, niti i kanalu,
- idempotency na slanju odgovora,
- jasno odvojene dev/stage/prod Meta app konfiguracije,
- revizijski trag za svako automatsko i ručno preuzimanje niti.

**⚠️ Kritičan operativni zahtev — Meta mTLS webhook promena (mart 2026.):**

Od **31. marta 2026.** Meta je prešla sa DigiCert na sopstveni CA za potpisivanje webhook mTLS sertifikata. Ako vaš server ili load balancer vrši client certificate verification (npr. `ssl_verify_client` u Nginx-u ili ekvivalentna konfiguracija), morate ažurirati trust store sa novim Meta root CA sertifikatom:

```
Fajl: meta-outbound-api-ca-2025-12.pem
Izvor: Meta for Developers — "Getting Started with Webhooks" dokumentacija
Common name: client.webhooks.fbclientcerts.com
```

Neažurirani trust store → TLS handshake failure → bot prestaje da prima poruke. Stari DigiCert sertifikat je istekao 15. aprila 2026. Ako ne koristite mTLS client cert verification, ova promena vas ne pogađa.

Dodatni realni rizici i mitigacije:

| Rizik | Posledica | Mitigacija |
|---|---|---|
| LLM halucinacija | pogrešan odgovor kupcu | pravila i RAG pre LLM-a, confidence threshold, "human fallback", eval set |
| Nepoštovanje 24h prozora | kršenje Meta politike | centralni policy middleware i testovi za messaging window |
| Curenje tokena | neovlašćen pristup Page/IG nalogu | Secret Manager, rotacija, least privilege, appsecret_proof |
| Prekomerno prikupljanje PII | GDPR problem | data minimization, privacy notice, retention policy, delete workflow |
| Webhook outage | gubitak događaja ili unsubscribe | health checks, retries, alarmi, DLQ, multi-AZ hosting |
| mTLS trust store nije ažuriran | webhooks prestaju da rade | ažurirati na meta-outbound-api-ca-2025-12.pem |
| Self-hosted model slab za srpski | nizak kvalitet i veća eskalacija | interni benchmark na srpskom pre produkcije |

Meta dokumentacija dodatno skreće pažnju na to da Instagram messaging webhook i inbox ponašanje imaju svoje specifičnosti — na primer, poruke dobijene preko API-ja na Instagramu nisu nužno označene kao "pročitane" dok se ne pošalje odgovor — pa UI očekivanja tima podrške treba unapred uskladiti.

### Testiranje i deployment opcije

Strategija testiranja treba da ima četiri sloja:

1. unit testovi za signature proveru, intent router, policy middleware, serializers,
2. integration testovi za Graph API adaptere, token refresh i CRM/ticketing adaptere,
3. end-to-end testovi sa test korisnicima/ulogama i realnim webhook događajima,
4. load testovi za burst prijeme i retry scenarije.

Posebno bih insistirao na "policy testovima" za 24h window, Human Agent put i routing ka čoveku, jer su to mesta gde bot najčešće pada poslovno, a ne tehnički.

Za CI/CD je najpraktičniji GitHub Actions: build, lint, unit/integration test, container build, sigurnosna provera dependencija, deploy u stage, smoke test, pa tek onda produkcija.

| Deployment opcija | Prednosti | Mane | Preporuka |
|---|---|---|---|
| Heroku | najbrži MVP, Docker deploy preko Container Registry, mali ops teret | manja kontrola i skuplje skaliranje po jedinici rada | dobro za brzi početak |
| AWS ECS Fargate | serverless kontejneri bez upravljanja serverima, dobar enterprise fit | AWS kompleksnost i dodatni troškovi oko ekosistema | vrlo dobra produkciona opcija |
| Google Cloud Run | potpuno upravljani serverless kontejneri, scale-to-zero, vrlo dobar fit za webhook API | zahteva GCP operativni model | odličan izbor za API/worker workload |
| Docker na VM | maksimalna kontrola i najmanja platform abstraction | najveći ops teret | samo ako već imate jak infra tim |
| Kubernetes | najbolji za više servisa i ozbiljan enterprise scale | najveća složenost i potreba za planiranjem produkcionog klastera | smislen tek kad sistem naraste |

---

## Troškovi, plan implementacije, primeri koda i checklist

### Troškovi i budžetne procene

*(Cene verifikovane: 13. jun 2026.)*

Zbog nepoznatog volumena poruka, nepoznatog broja agenata i nepoznatog postojećeg sistema, tačne cene su neodređene.

**Minimalni MVP** za jednu firmu, jedan ili dva kanala, bez teške CRM integracije:

- infrastruktura i osnovne managed komponente: okvirno €40–150 mesečno,
- AI usage: €0–100 mesečno pri nižem volumenu ako LLM nije uključen u svaku poruku,
- jednokratna implementacija: okvirno 112–184 sati.

**Srednji nivo** sa CRM/ticketing integracijom, analitikom i jačim guardrails-ima:

- infrastruktura i AI: okvirno €300–1.500 mesečno,
- implementacija: 240–420 sati.

**Enterprise** sa više brandova/kanala, strožom usklađenošću, HA zahtevima i self-hosted ili naprednijim AI slojem:

- infrastruktura i AI: €2.500+ mesečno,
- implementacija: 700+ sati.

Za osećaj reda veličine, zvanične javne cene pokazuju:

| Resurs | Cena |
|---|---|
| GPT-4o input | $2,50 / 1M tokena |
| GPT-4o output | $10 / 1M tokena |
| GPT-4o mini input | $0,15 / 1M tokena |
| GPT-4o mini output | $0,60 / 1M tokena |
| text-embedding-3-large | $0,13 / 1M tokena (standardno) |
| text-embedding-3-large (Batch API) | $0,065 / 1M tokena — **50% popust** za asinhrone workload-ove |
| Heroku Basic dyno | od $7/mesec |
| AWS Fargate | prema utrošenom vCPU/memoriji |
| Google Cloud Run | prema stvarnoj upotrebi, scale-to-zero |

**Savet:** OpenAI Batch API nudi 50% popust na embeddings i podržane modele. Za procese koji ne zahtevaju real-time odgovor (npr. noćna reindeksacija baze znanja, batch embeddings novih dokumenata), Batch API može značajno smanjiti mesečne troškove.

### Plan implementacije i resursi

| Faza | Trajanje | Glavni deliverables | Procena sati |
|---|---|---|---|
| Discovery i compliance setup | 3–5 radnih dana | Meta App, permission mapa, privacy/data deletion, env model | 16–28h |
| Core messaging | 1 nedelja | webhook verify/signature, send API, conversation store | 32–48h |
| Bot logika i RAG | 1–2 nedelje | intent routing, FAQ knowledge base, fallback logika | 40–72h |
| Handoff i integracije | 1 nedelja | human routing/ticketing/CRM adapter | 24–48h |
| Hardening i launch | 1 nedelja | testovi, observability, CI/CD, deployment, checklist | 24–40h |

Preporučeni tim za MVP:

- 1 backend/full-stack inženjer kao nosilac,
- 1 AI/NLP inženjer part-time ili senior backend koji ume RAG/guardrails,
- 1 QA/PM part-time,
- po potrebi 1 pravnik/DPO konsultativno za privacy notice, retention i lawful basis.

---

## Skeletni primer koda — Node.js

Primer ispod prati preporučeni obrazac: webhook validacija, raw body HMAC provera (sa ispravnim length-safe poređenjem), pravila prvo, LLM fallback sa error handling-om, pa slanje odgovora preko Graph API-ja.

```js
// package intent: Node.js 24 LTS + Express 5 + OpenAI JS SDK 6.x
import express from "express";
import crypto from "node:crypto";
import OpenAI from "openai";

// --- Validacija env varijabli pri startu (fail-fast) ---
const REQUIRED_ENV = [
  "OPENAI_API_KEY",
  "META_VERIFY_TOKEN",
  "META_APP_SECRET",
  "META_PAGE_ACCESS_TOKEN",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: nedostaje env varijabla: ${key}`);
    process.exit(1);
  }
}

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Deduplikacija po message ID (koristiti Redis u produkciji, sa TTL-om)
const processedMids = new Set();

// GET — verification handshake
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST — webhook prima događaje; raw body obavezan za HMAC proveru
// Limit 2 MB štiti od prevelikih payload-a
app.post("/webhook", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  // 1) Proveri potpis PRE acknowledgment-a — ako ne prođe, vrati 403
  try {
    verifyMetaSignature(req);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.sendStatus(403);
  }

  // 2) Acknowledge odmah — Meta šalje retry ako ne dobije 200 brzo
  res.sendStatus(200);

  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    console.error("Invalid JSON in webhook payload");
    return;
  }

  if (body.object !== "page" || !Array.isArray(body.entry)) return;

  // 3) Obradi svaki event — izoluj greške po poruci (jedna ne sme da blokira ostale)
  // U produkciji: payload gurnuti u queue (Redis/SQS), obraditi u worker procesu
  for (const entry of body.entry) {
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const text = event.message?.text?.trim();
      const mid = event.message?.mid;

      if (!senderId || !text) continue;

      // Deduplikacija — Meta može da pošalje isti event više puta pri retry-u
      if (mid) {
        if (processedMids.has(mid)) continue;
        processedMids.add(mid);
        // U produkciji: Redis SETNX sa TTL-om od ~24h
      }

      try {
        const reply = await routeMessage(text);
        await sendText(process.env.META_PAGE_ACCESS_TOKEN, senderId, reply);
      } catch (err) {
        // Loguj grešku i nastavi sa sledećom porukom — ne propagiraj gore
        console.error(`Error processing message from ${senderId} (mid=${mid}):`, err);
        // U produkciji: poslati u dead-letter queue za retry
      }
    }
  }
});

/**
 * Verifikuje X-Hub-Signature-256 potpis koristeći constant-time poređenje.
 *
 * BUG FIX: crypto.timingSafeEqual() baca TypeError ako buffers nisu iste dužine.
 * Zato se length proverava pre poređenja — razlika u dužini je sama po sebi
 * nevažeći potpis, ne greška.
 */
function verifyMetaSignature(req) {
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) throw new Error("Missing X-Hub-Signature-256 header");

  const expectedHash =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.META_APP_SECRET)
      .update(req.body)
      .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedHash);

  // Provera dužine mora biti pre timingSafeEqual — ista dužina je uslov
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid webhook signature");
  }
}

async function routeMessage(text) {
  // 1) Pravila prva — deterministično, besplatno, nulta latencija
  if (/(radno vreme|working hours|otvoreno)/i.test(text)) {
    return "Radimo pon-pet 09:00-17:00. Ako želite, mogu da vas povežem sa agentom.";
  }

  if (/(agent|operater|covek|čovek|human)/i.test(text)) {
    // U produkciji: pokrenuti Conversation Routing / otvoriti handoff tiket
    return "Naravno — proslediću razgovor ljudskom agentu.";
  }

  // 2) LLM fallback — uvek sa try/catch da bot ostane dostupan ako API pukne
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "Ti si bot za korisničku podršku. Odgovaraj kratko, tačno i bez izmišljanja. " +
            "Ako nisi siguran, reci da ćeš proslediti agentu.",
        },
        { role: "user", content: text },
      ],
    });
    return response.output_text?.trim() || "Hvala na poruci. Proslediću ovo agentu.";
  } catch (err) {
    console.error("LLM call failed:", err);
    // Graceful degradation — bot ne sme da ućuti
    return "Trenutno ne mogu da odgovorim automatski. Proslediću vaš upit agentu.";
  }
}

async function sendText(pageAccessToken, recipientId, text) {
  const url = new URL("https://graph.facebook.com/v25.0/me/messages");
  url.searchParams.set("access_token", pageAccessToken);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Meta send failed: ${resp.status} ${errBody}`);
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log("Webhook server started on port", process.env.PORT || 3000);
});
```

---

## Skeletni primer koda — Python

Python varijanta je posebno dobra ako planirate RAG, embeddings i NLP eksperimentisanje. Koristi `AsyncOpenAI` klijent koji je obavezan u async FastAPI kontekstu — sinhronski `OpenAI` klijent bi blokirao event loop.

```python
# intent: Python 3.13 + FastAPI + OpenAI Python SDK (async)
import os
import hmac
import json
import hashlib
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import PlainTextResponse
from openai import AsyncOpenAI  # BUG FIX: mora biti AsyncOpenAI, ne OpenAI!

# --- Validacija env varijabli pri startu (fail-fast) ---
_REQUIRED_ENV = [
    "OPENAI_API_KEY",
    "META_VERIFY_TOKEN",
    "META_APP_SECRET",
    "META_PAGE_ACCESS_TOKEN",
]
for _key in _REQUIRED_ENV:
    if not os.environ.get(_key):
        raise RuntimeError(f"FATAL: nedostaje env varijabla: {_key}")

app = FastAPI()
client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

META_VERIFY_TOKEN = os.environ["META_VERIFY_TOKEN"]
META_APP_SECRET = os.environ["META_APP_SECRET"]
META_PAGE_ACCESS_TOKEN = os.environ["META_PAGE_ACCESS_TOKEN"]

# Deduplikacija po message ID (koristiti Redis u produkciji, sa TTL-om)
_processed_mids: set[str] = set()


@app.get("/webhook")
async def verify_webhook(request: Request):
    params = request.query_params
    if (
        params.get("hub.mode") == "subscribe"
        and params.get("hub.verify_token") == META_VERIFY_TOKEN
    ):
        return PlainTextResponse(params.get("hub.challenge", ""))
    raise HTTPException(status_code=403, detail="Verification failed")


@app.post("/webhook")
async def webhook(request: Request):
    # Limit 2 MB štiti od prevelikih payload-a
    MAX_BODY = 2 * 1024 * 1024
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise HTTPException(status_code=413, detail="Payload too large")

    verify_signature(raw, request.headers.get("X-Hub-Signature-256"))

    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # U produkciji: odmah odgovoriti 200 i gurnuti u queue, obraditi u worker-u
    if payload.get("object") != "page":
        return {"ok": True}

    for entry in payload.get("entry", []):
        for event in entry.get("messaging", []):
            sender_id = (event.get("sender") or {}).get("id")
            msg = event.get("message") or {}
            text = msg.get("text")
            mid = msg.get("mid")

            if not sender_id or not text:
                continue

            # Deduplikacija — Meta može da pošalje isti event više puta pri retry-u
            if mid:
                if mid in _processed_mids:
                    continue
                _processed_mids.add(mid)
                # U produkciji: Redis SETNX sa TTL-om od ~24h

            try:
                reply = await route_message(text.strip())
                await send_text(sender_id, reply)
            except Exception as exc:
                # Loguj grešku i nastavi — jedna poruka ne sme blokirati ostale
                print(f"Error processing message from {sender_id} (mid={mid}): {exc}")
                # U produkciji: poslati u dead-letter queue za retry

    return {"ok": True}


def verify_signature(raw: bytes, signature: str | None) -> None:
    """
    Verifikuje X-Hub-Signature-256 potpis koristeći constant-time poređenje.
    Baca HTTP 403 ako potpis nedostaje ili nije validan.
    """
    if not signature:
        raise HTTPException(status_code=403, detail="Missing X-Hub-Signature-256 header")

    # Eksplicitni keyword argumenti za čitljivost i jasnu nameru
    mac = hmac.new(
        key=META_APP_SECRET.encode("utf-8"),
        msg=raw,
        digestmod=hashlib.sha256,
    )
    expected = "sha256=" + mac.hexdigest()

    # hmac.compare_digest — constant-time, štiti od timing napada
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=403, detail="Invalid signature")


async def route_message(text: str) -> str:
    lower = text.lower()

    # 1) Pravila prva — deterministično, besplatno, nulta latencija
    if any(k in lower for k in ["radno vreme", "otvoreno", "hours"]):
        return "Radimo pon-pet 09:00-17:00."

    if any(k in lower for k in ["agent", "operater", "čovek", "covek", "human"]):
        # U produkciji: pokrenuti Conversation Routing / otvoriti handoff tiket
        return "U redu — proslediću razgovor agentu."

    # 2) LLM fallback — await na AsyncOpenAI (non-blocking!); uvek sa try/except
    try:
        resp = await client.responses.create(
            model="gpt-4o-mini",
            input=[
                {
                    "role": "system",
                    "content": (
                        "Ti si bot korisničke podrške. Odgovaraj kratko, tačno i bez izmišljanja. "
                        "Ako nešto nije dovoljno jasno, predloži razgovor sa agentom."
                    ),
                },
                {"role": "user", "content": text},
            ],
        )
        return (resp.output_text or "").strip() or "Hvala. Proslediću poruku agentu."
    except Exception as exc:
        print(f"LLM call failed: {exc}")
        # Graceful degradation — bot ne sme da ućuti
        return "Trenutno ne mogu da odgovorim automatski. Proslediću vaš upit agentu."


async def send_text(recipient_id: str, text: str) -> None:
    url = "https://graph.facebook.com/v25.0/me/messages"
    params = {"access_token": META_PAGE_ACCESS_TOKEN}
    payload = {
        "recipient": {"id": recipient_id},
        "messaging_type": "RESPONSE",
        "message": {"text": text},
    }

    async with httpx.AsyncClient(timeout=20.0) as http:
        r = await http.post(url, params=params, json=payload)
        # Eksplicitna provera umesto raise_for_status() — čitljivija greška
        if not r.is_success:
            raise RuntimeError(f"Meta send failed: {r.status_code} {r.text}")
```

---

## Checklist za lansiranje

Pre puštanja u rad proverio bih sledeće:

- [ ] Meta App je u Live Mode.
- [ ] Permissions i, gde treba, Advanced Access su odobreni.
- [ ] Privacy Policy i Data Deletion Callback/URL su javno dostupni i testirani.
- [ ] Webhook GET verify i POST signature provere rade u sva tri okruženja.
- [ ] Koristite eksplicitnu Graph API verziju, na primer `v25.0`.
- [ ] **mTLS trust store ažuriran sa `meta-outbound-api-ca-2025-12.pem`** (ako koristite client cert verification).
- [ ] Bot poštuje 24h window i Human Agent tok.
- [ ] Tokeni su u Secret Manager-u, ne u .env fajlovima na hostu.
- [ ] Svi odgovori imaju fallback ka čoveku.
- [ ] Postoje dashboardi za p95 response time, handoff rate i error rate.
- [ ] Postoji procedura za brisanje korisničkih podataka i audit trag da je izvršena.
- [ ] Postoje smoke testovi posle svakog deploy-a.
- [ ] Tim podrške zna da Messenger desktop aplikacija više ne postoji — inbox je u Facebook Business Suite ili integriranom helpdesk alatu.
- [ ] Tim zna operativni proces: ko preuzima razgovor, gde vidi tiket, koliko brzo reaguje.
- [ ] Redis/Valkey licenca je pregledana i usklađena sa pravilima organizacije.
- [ ] Verzije svih dependency-ja su pinuvane i postoji kalendarski podsetnik za upgrade pre isteka Meta API verzije.

---

## Otvorena pitanja i ograničenja

Ovaj izveštaj je namerno projektovan za greenfield slučaj. Zbog toga su sledeće stavke i dalje neodređene i direktno utiču na konačnu arhitekturu, rok i cenu:

- da li već imate CRM, ticketing, ERP ili webshop,
- da li je Instagram nalog već povezan sa Facebook Page,
- koji je mesečni/vršni volumen poruka,
- da li želite samo tekst ili i mediju/priloge,
- da li će bot raditi samo za vaš biznis ili kao multi-tenant rešenje za više klijenata,
- da li imate pravni osnov i interni proces za retention/deletion,
- da li želite cloud API modele ili self-hosted open-source model zbog privatnosti/suvereniteta,
- da li vaša infrastruktura koristi mTLS client cert verification na webhook endpoint-u (relevantno za mTLS trust store ažuriranje).

Najveća praktična ograničenja pri ovakvom projektu nisu tehnička nego operativna: loša baza znanja, nejasna pravila eskalacije, nedostatak ownership-a za ljudsku podršku i nedefinisana pravila čuvanja podataka gotovo uvek kvare rezultat više nego sam izbor framework-a ili LLM-a.
