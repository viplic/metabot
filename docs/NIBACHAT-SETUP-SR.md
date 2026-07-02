# NibaChat setup za novog klijenta

Ovaj redosled koristi za svaki novi biznis. Cilj je da klijent ne dira kod, vec da se sve podesi kroz NibaChat panel.

## 1. Osnovno

Popuni:

- Naziv biznisa
- Kratak opis: sta prodaje, kome prodaje, stil komunikacije
- URL sajta/shopa
- Drzava/slanje
- Rok izrade i isporuke
- Cena dostave
- Pravila reklamacije i zamene

Opis treba da bude konkretan, na primer:

> Prodajemo personalizovani nakit od nerdjajuceg celika. Dostava je 10 KM za celu BiH. Rok izrade i isporuke je 2-3 radna dana. Zamena nije moguca zbog personalizacije. Ako je reklamacija osnovana i kupac je porucio kod nas, mi snosimo trosak.

## 2. AI

U admin panelu unesi AI API kljuc za tog klijenta. Klijent ga ne vidi.

Preporuceno:

- Provider: `openai`
- Model: `gpt-5.5`
- Temperatura: `0.15`
- Max izlaz tokena: `320`
- Max slika: `2`
- Model routing ukljucen

Sistemski prompt treba da bude kratak i izolovan po klijentu:

> Odgovaraj kratko, prirodno i tacno kao korisnicka podrska ovog shopa. Ne pominji AI. Koristi samo podatke ovog klijenta, katalog, pravila, FAQ i razgovor. Ne salji linkove osim ako korisnik izricito trazi. Kada das cenu ili resis pitanje oko kupovine, dodaj: "Ako zelite da porucite, ostavite nam vase podatke."

## 3. Meta povezivanje

Za stabilno povezivanje koristi dugme **Povezi preko Facebook login-a** u NibaChat panelu.

Potrebno je:

- Meta App ID
- Meta App Secret
- Business Login Configuration ID
- Facebook Page ID
- Instagram Business Account ID ako odgovara i na Instagram

Ne koristi rucni User Access Token osim ako Meta ponisti dozvole. Rucni token sluzi samo za obnovu Page tokena.

Posle povezivanja uvek klikni **Proveri Meta tokene**.

Dobro stanje:

- Facebook Messenger: `OK`
- Instagram Direct: `OK`
- Webhook: `subscribed`

Ako pise da realna poruka jos nije vidjena, posalji test sa naloga koji nije vlasnik/admin stranice.

## 4. Google Sheet

U Google Apps Script deploy mora biti:

- Execute as: `Me`
- Who has access: `Anyone`
- URL mora da se zavrsava sa `/exec`

U NibaChat unesi:

- Google Sheet webhook URL za porudzbine: Apps Script `/exec`
- Google Sheet pregledni link: obican `docs.google.com/spreadsheets/...`

## 5. Znanje

Znanje unosi po temama, ne sve u jedan blok:

- Cene proizvoda
- Dostava
- Placanje
- Rok izrade/isporuke
- Reklamacije
- Zamene
- Materijal i garancija
- Pakovanje
- Podaci za porudzbinu

Najbrzi nacin:

1. Otvori tab **Znanje**.
2. Klikni **Dodaj osnovne teme**.
3. U svakoj temi zameni primer stvarnim pravilima tog shopa.
4. Sacuvaj izmene.
5. Testiraj pitanja iz odeljka "Test pre pustanja".

Direktan odgovor koristi kada zelis isti odgovor svaki put, na primer:

> Dostava je 10 KM za celu BiH. Ako zelite da porucite, ostavite nam vase podatke.

Sta nikad ne ostavljati prazno:

- Cena dostave
- Drzave/gradovi gde se salje
- Rok izrade i isporuke
- Nacin placanja
- Da li je zamena moguca
- Ko placa trosak reklamacije
- Materijal i garancija
- Da li paket dolazi u poklon kutiji

Za proizvode:

- Ako shop ima sajt, prvo popuni **URL sajta/shopa** i klikni **Ucitaj proizvode i pravila sa sajta**.
- Ako neki proizvod ima posebnu cenu, dodaj ga kao poseban dokument u znanju.
- Ako kupac posalje sliku, sistem pokusava da je veze za katalog i cenu. Ako slika nije jasna, trazi jasniju sliku ili naziv proizvoda, ne link.

## 6. Porudzbine

Automatizacija trazi i parsira:

- Ime i prezime
- Grad
- Postanski broj
- Ulicu i broj
- Broj telefona
- Proizvod
- Napomenu, boju, model ili tekst za graviranje ako ih kupac posalje

Kada su podaci kompletni, red ide u Google Sheet.

## 7. Test pre pustanja

Za svaki novi klijent testiraj:

- Koliko je dostava?
- Koja je cena proizvoda?
- Za koliko dana stize?
- Da li mogu zamenu?
- Da li dolazi u poklon kutiji?
- Posalji sliku proizvoda
- Posalji kompletnu porudzbinu
- Posalji reklamaciju

Ako odgovor trazi link, previse objasnjava ili ide u handoff bez potrebe, dodaj pravilo ili dokument u bazu znanja za tog klijenta.

## 8. Kako radi ucenje

Ucenje je odvojeno po klijentu. Jedan biznis nikada ne koristi razgovore drugog biznisa.

Opcije:

- **Uci iz novih nesigurnih razgovora**: kada sistem nije siguran, napravi predlog odgovora za taj biznis.
- **Uci iz starih razgovora**: analizira poslednjih 20-30 razgovora tog biznisa i predlaze nova pravila/odgovore.
- **Auto-odobri naucene odgovore**: ne preporucuje se za prve klijente. Bolje je da admin odobri predloge.

Preporucen rad:

1. Pusti automatizaciju da radi.
2. Jednom dnevno otvori tab **Znanje**.
3. Pregledaj predloge za ucenje.
4. Ispravi tekst ako treba.
5. Klikni **Odobri u znanje**.

Tako baza znanja postaje bolja bez mesanja klijenata.
