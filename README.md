# Notenverwaltung Webapp

Multi-User-Notenverwaltung als **Single-Process-Node.js-App**, erreichbar
direkt unter der Subdomain ohne Reverse-Proxy, ohne gunicorn, ohne
Portverwaltungs-Workarounds.

Architektur: **wie `notentabellen-spa`** — Fastify + better-sqlite3,
alles in einem Prozess, alles auf einem Port. Plesk-Node.js startet
die App direkt und routet die Subdomain darauf.

## Stack

| Komponente  | Technologie                                |
|-------------|--------------------------------------------|
| Server      | Fastify 4                                  |
| Views       | EJS (server-gerendert)                     |
| Datenbank   | better-sqlite3 (eine Datei, synchron)      |
| Auth        | `@fastify/session` + bcryptjs              |
| Notenlogik  | 1:1 portiert aus `src/grade_calc.py`       |
| Frontend    | Vanilla CSS (kein CDN, keine Build-Pipeline), unterstützt Dark Mode |

## Funktionen

- **Rollen:** Admin / Lehrkraft / Klassenleitung
- **Setup:** Beim ersten Start wird der erste Admin via `/setup` angelegt
- **LDAP/Active-Directory-Login:** optional, siehe Abschnitt „LDAP-Konfiguration"
  unten. Ist LDAP nicht konfiguriert, ändert sich am Verhalten nichts.
- **Externe Lehrkräfte ohne LDAP-Zugang:** Admin erzeugt Einladungslinks,
  Lehrkräfte wählen selbst Benutzername + Passwort (lokales Konto)
- **Notenverwaltung:** Klausuren, Unterrichtsleistungen (ULs), mündlich/schriftlich,
  mit automatischer Gewichtung
- **Notentafel:** Live-Gesamtnoten via AJAX
- **Fehlzeiten:** Pro Halbjahr, drei Typen (entschuldigt/unentschuldigt/betrieblich),
  optional mit zweiter Schule (siehe unten)
- **CSV-Export:** Pro Klasse oder komplettes Schuljahr (UTF-8 BOM, Excel-freundlich)
- **Notenschlüssel:** IHK (1–6) und BG (0–15), pro Klasse mit eigenem CSV

## Lokal starten

```bash
# Voraussetzungen: Node.js >= 20
npm install
npm start         # → http://localhost:3001
```

Beim ersten Start wirst du auf `/setup` geleitet und legst den Admin an.

### Tests

```bash
npm test
```

Deckt:
- **Notenberechnung** (gleiche Szenarien wie der Python-Smoketest)
- **End-to-End-Smoketest** (Setup → Klasse → Fach → Schüler/in → Notentafel → CSV)

### CLI: Admin direkt anlegen

```bash
node src/cli/seed-admin.js --username admin --display "T. Lehrer" --password geheim123
```

## LDAP-Konfiguration

Lehrkräfte können sich statt mit einem lokalen Passwort mit ihrer
LDAP/Active-Directory-Kennung anmelden. Das Vorgehen (Konfiguration,
Direkt-Bind vs. Service-Account, TLS) ist 1:1 aus `notentabellen-spa`
übernommen (`src/auth/ldap.js`).

### Konfigurationsquelle: Admin-Oberfläche oder Plesk-ENV-Variablen

Die LDAP-Konfiguration kann entweder direkt in der App unter
**Admin → LDAP-Einstellungen** eingetragen werden, oder wie bisher über
`LDAP_*`-Umgebungsvariablen in der Plesk-Node.js-UI. Ist unter
„LDAP-Einstellungen" eine LDAP-URL gespeichert, hat sie Vorrang — die
ENV-Variablen werden dann ignoriert (kein Mischen beider Quellen). Ohne
gespeicherte Einstellungen greifen wie gehabt die ENV-Variablen.

Das Service-Account-Passwort wird bei Eingabe über die Oberfläche
**verschlüsselt** in der DB abgelegt (AES-256-GCM, Schlüssel aus `SECRET`
abgeleitet — siehe `src/auth/secret-crypto.js`) und kann über die
Oberfläche **nicht wieder im Klartext angezeigt** werden; ein leeres
Passwort-Feld beim Speichern lässt ein bereits gesetztes Passwort
unverändert.

### Wer darf sich anmelden?

Zwei Modi, einstellbar unter Admin → LDAP-Einstellungen:

- **Ohne Auto-Provisioning (Standard bei reiner ENV-Konfiguration):**
  Rollen/Konten kommen ausschließlich aus der lokalen DB. Eine LDAP-Anmeldung
  funktioniert nur für Konten, die der Admin vorher unter
  **Admin → LDAP-Import** angelegt hat (Verzeichnis durchsuchen oder
  LDAP-Kennung manuell eintragen → „Anlegen").
- **Mit Auto-Provisioning** (Haken „Anmeldung ohne Vorab-Import"): Jede
  Person mit gültigen LDAP-Zugangsdaten kann sich anmelden — das Konto
  (Rolle „Lehrkraft") wird beim ersten erfolgreichen Login automatisch
  angelegt, ganz ohne Admin-Aktion. **Achtung:** Das gilt für jeden Bind,
  der zu Base-DN/Suchfilter passt — bei einem gemeinsamen Verzeichnis mit
  z. B. Schüler-Konten unbedingt Base-DN/Filter auf die Lehrkräfte-OU
  eingrenzen.

### Env-Variablen (Plesk-Node.js-UI → Umgebungsvariablen)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `LDAP_URL` | für LDAP-Login | z. B. `ldaps://dc01.schule.local:636`. Fehlt sie, ist LDAP komplett deaktiviert. |
| `LDAP_BASE_DN` | für LDAP-Login | Such-Basis, z. B. `DC=schule,DC=local` |
| `LDAP_USER_FILTER` | optional | Default `(sAMAccountName={{username}})` |
| `LDAP_BIND_USER_TEMPLATE` | Variante A | Direkt-Bind, z. B. `SCHULE\{{username}}` oder `{{username}}@schule.local` — kein Service-Account fürs Login nötig |
| `LDAP_BIND_DN` / `LDAP_BIND_PW` | Variante B, **immer** für den LDAP-Import | Service-Account. Wird für die Admin-Verzeichnissuche gebraucht, selbst wenn Login per Direkt-Bind läuft |
| `LDAP_LOGIN_ATTR` | optional | Default `sAMAccountName` |
| `LDAP_NAME_ATTR` | optional | Default `displayName` |
| `LDAP_TEACHER_SEARCH_FILTER` | optional | Filter für die Admin-Suche, `{{query}}` wird ersetzt |
| `LDAP_TLS_CA_PFAD` | optional | Pfad zur PEM-Datei der internen CA |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | optional | `false` schaltet die Zertifikatsprüfung ab (nur Notlösung) |

Siehe `.env.example` für ein vollständiges Beispiel.

### Ablauf

1. ENV-Variablen in Plesk setzen, App neu starten.
2. Admin → **LDAP-Import** → Lehrkraft suchen → **„Als Lehrkraft anlegen"**.
3. Die Lehrkraft meldet sich künftig mit ihrer gewohnten LDAP-Kennung + AD-Passwort an.
4. Diagnose bei Problemen: `npm run ldap-test -- <benutzername> <passwort>` auf
   dem Server (zeigt die aufgelöste Konfiguration und den genauen Fehler).

Externe Lehrkräfte ohne LDAP-Konto laufen unverändert über den
Einladungslink (Admin → Einladungen) — beide Kontotypen (LDAP / lokal)
funktionieren parallel und sind in **Admin → Lehrkräfte** an der Spalte
„Quelle" zu erkennen.

## Fehlzeiten: optionale zweite Schule

Manche Schüler/innen werden an zwei Schulen unterrichtet (z. B. duales
Modell) — dann müssen Fehlzeiten an beiden Schulen erfasst werden. Auf der
Fehlzeiten-Seite einer Klasse kann die Klassenleitung/der Admin den Haken
„Schüler/innen werden an zwei Schulen unterrichtet" setzen. Danach bekommt
jede Fehlzeitenart (entschuldigt/unentschuldigt/betrieblich) zwei
Stunden-Spalten (Schule 1 / Schule 2) plus eine live berechnete Summe. Ohne
den Haken bleibt die Ansicht wie bisher (eine Spalte je Typ) — das ist rein
optional pro Klasse.

## Klassen selbst anlegen (ohne Admin-Zuweisung)

Jede angemeldete Lehrkraft kann unter **„Meine Klassen"** eigene Klassen in
einem bestehenden Schuljahr anlegen — eine vorherige Zuweisung durch den
Admin ist nicht nötig. Beim Anlegen eines Fachs wird die erstellende
Lehrkraft automatisch diesem Fach zugewiesen (sieht es sofort in der eigenen
Notentafel).

Schuljahre selbst legt weiterhin nur der Admin an (Admin → Dashboard).

### Klassenleitung (selbst eintragen, nicht nur Admin)

Die Person, die eine Klasse angelegt hat, kann sich auf der Klassenseite
selbst als **Klassenleitung** eintragen (Admin kann das für jede Klasse
ebenfalls). Als Klassenleitung:

- kann sie weitere Fächer anlegen,
- kann sie **andere Lehrkräfte** Fächern dieser Klasse zuordnen — bisher
  ging das nur über Admin → Zuweisungen, jetzt zusätzlich direkt auf der
  Klassenseite,
- sieht sie in der **Halbjahresübersicht** die zuletzt synchronisierten
  Noten aller Fächer der Klasse (siehe unten) — **nicht** live die
  Notentafeln der einzelnen Fachlehrkräfte, das bleibt bewusst diesen
  vorbehalten.

Jede Lehrkraft sieht die Live-Notentafel weiterhin nur für Fächer, die sie
selbst angelegt hat oder denen sie zugewiesen wurde — auch die
Klassenleitung nicht ausgenommen.

### Verknüpfungsanfrage bei Namenskollisionen

Legt jemand eine Klasse mit einem Namen an, der in diesem Schuljahr schon
vergeben ist, entsteht **keine zweite, doppelte Klasse**. Stattdessen:

- Ist die bestehende Klasse noch mit niemandem verbunden (z. B. eine leere,
  vom Admin angelegte Hülle), bekommt die anfragende Person sofort Zugriff
  mit dem von ihr genannten Fach.
- Ist die Klasse bereits mit Personen verbunden (Ersteller/in,
  Klassenleitung, zugewiesene Lehrkräfte), wird eine **Verknüpfungsanfrage**
  gestellt: Alle diese Personen sehen sie unter „Meine Klassen" und müssen
  zustimmen. Lehnt auch nur eine Person ab, ist die Anfrage beendet. Stimmen
  alle zu, wird das von der anfragenden Person genannte Fach angelegt
  (falls es das noch nicht gibt) und sie diesem Fach zugewiesen.

### Import aus Untis (`/teacher/untis-import`)

Klassen (und optional Schüler/innen) lassen sich aus WebUntis importieren,
ohne die Klasse vorher manuell anzulegen. **Wichtig, bitte lesen:**

- Es gibt **keine offizielle, dokumentierte Programmierschnittstelle** für
  einen einzelnen Lehrkraft-Login. Untis selbst bietet nur eine
  Partner-API mit schulweiten OAuth-Client-Credentials an (Einrichtung
  durch einen Untis-Admin, kein Login mit persönlichen Zugangsdaten). Diese
  Anbindung nutzt stattdessen die seit Jahren von der Community
  reverse-engineerte JSON-RPC-Schnittstelle (`/WebUntis/jsonrpc.do`), die
  auch der offizielle Untis-Login im Browser verwendet — inoffiziell, ohne
  Zusicherung, dass sie dauerhaft funktioniert oder mit den Untis-AGB
  vereinbar ist.
- **Zwei Anmeldearten** (`src/untis-client.js`): Benutzername+Passwort
  (Methode `authenticate`) funktioniert nur, wenn am Untis-Konto **keine
  Zwei-Faktor-Authentifizierung** erzwungen wird. Ist 2FA aktiv (wie am
  BBZ RD-Eck), muss stattdessen ein **Secret** verwendet werden — das
  Untis-Profil zeigt es unter „Freigaben"/„Mobile-Zugriff" → „QR-Code
  anzeigen" (Secret steht meist als Klartext neben dem QR-Code). Daraus
  wird ein 6-stelliger TOTP-Code berechnet (Methode `getUserData2017`,
  Endpunkt `/WebUntis/jsonrpc_intern.do`) — derselbe Mechanismus, den
  Untis Mobile selbst nutzt. **Achtung:** ein neu erzeugter QR-Code kann
  eine bereits auf dem Handy gekoppelte Untis-Mobile-Anmeldung ungültig
  machen.
- **Kein Passwort/Secret wird gespeichert.** Jede Lehrkraft meldet sich bei
  jeder Verbindung neu mit den eigenen Untis-Zugangsdaten an;
  die Sitzung liegt nur kurz im Server-Session-Speicher und wird nach dem
  Import (oder per „Verbindung trennen") sofort beendet.
- **Schülerlisten je Klasse sind über die API nicht zuverlässig abrufbar —
  am BBZ RD-Eck sogar gar nicht.** Die WebUntis-API liefert zwar
  `getKlassen()` (Klassenliste) zuverlässig, aber es gibt keine
  dokumentierte Methode für „Schüler/innen einer Klasse":
  `getStudentGroupMembers(klasseId)` existiert auf dieser Untis-Instanz
  nicht (`-32601: Method not found`), und der schulweite Fallback
  `getStudents()` scheitert am fehlenden Recht „masterdata students read
  for all" (`-8509: no right for getStudents()`) — auch mit einem
  zusätzlich versuchten, undokumentierten `klasseId`-Filter pro Klasse.
  Beide bekannten API-Wege sind damit für ein normales Lehrkraft-Konto
  ohne erweiterte Rechte am BBZ RD-Eck ausgeschlossen (Details/Codepfade
  in `src/untis-client.js` und `routes/untis-import.js`, falls sich die
  Rechte am Konto später ändern und ein neuer Versuch sich lohnt).
  Klassen werden trotzdem angelegt; Schüler/innen lassen sich danach auf
  der Klassenseite ergänzen — entweder per Hand, per Sammel-Einfügen
  (Textfeld, eine Zeile je Person) oder per **CSV-Datei-Upload**
  (`POST /teacher/klassen/:id/schueler/csv`, `src/csv-import.js`): eine
  Spalte Nachname und eine Vorname, mit oder ohne Kopfzeile, Semikolon/
  Komma/Tab als Trennzeichen wird automatisch erkannt — z. B. für eine
  von Hand aus WebUntis oder einer anderen Schulverwaltungssoftware
  exportierte Liste. Dieser eine Endpunkt akzeptiert bewusst
  `multipart/form-data` in einem eigenen, gekapselten Fastify-Plugin-Scope
  (`@fastify/busboy` statt eines global registrierten Multipart-Plugins) —
  alle übrigen Formulare der App bleiben unverändert bei
  `application/x-www-form-urlencoded`.
- Klassen, die im Ziel-Schuljahr bereits existieren (Namenskollision),
  werden beim Import übersprungen statt dupliziert — bei Bedarf über die
  bestehende Verknüpfungsanfrage manuell verbinden.

### Noten-Sync statt Live-Zugriff für die Klassenleitung

Die Klassenleitung sieht **nie** die Live-Notentafel fremder Fächer — nur
die Lehrkraft, die einem Fach zugewiesen ist, kann dort Noten eintragen und
sehen. Damit die Klassenleitung trotzdem zum Halbjahresende einen Überblick
bekommt, synchronisiert jede Lehrkraft ihr Fach selbst:

- **„Jetzt synchronisieren"**-Button auf der Fachseite: überträgt den
  aktuellen Notenstand (Gesamtnote je Schüler/in, aktuelles Halbjahr) in
  einen für die Klassenleitung sichtbaren Sync-Stand.
- **Haken „automatisch mit Klassenleitung synchronisieren"**: ist er
  gesetzt, löst jede Notenänderung in diesem Fach sofort einen Sync aus,
  statt dass die Lehrkraft manuell auf den Button klicken muss.

Ohne einen der beiden Wege bleibt eine Lehrkraft für dieses Fach für die
Klassenleitung auf dem letzten synchronisierten Stand (oder „noch nie
synchronisiert") — eine permanente Live-Kontrolle durch die Klassenleitung
ist bewusst nicht möglich.

### Halbjahresübersicht (Klassenleitung/Admin)

Unter **Klasse → Halbjahresübersicht** sieht die Klassenleitung für das
gewählte Halbjahr eine Tabelle Schüler/in × Fach mit dem jeweils zuletzt
synchronisierten Stand, dem Zeitpunkt der letzten Synchronisierung je Fach,
einem Notenschnitt je Schüler/in (Durchschnitt über alle synchronisierten
Fächer), und — per Knopfdruck aufklappbar — allen Notizen aus
Notenbesprechungen/Notenkonferenzen (siehe unten) als Vorbereitung für
Halbjahresgespräche.

## Noteneingabe (vormals „Fächer")

Die Notentafel eines Fachs (jetzt „Noteneingabe" genannt) ist neu
strukturiert:

- **Notenübersicht** oben, direkt unter den Halbjahr-Reitern: eine Tabelle
  mit allen Schüler/innen, ihren manuellen mündlichen/schriftlichen Noten,
  sowie den berechneten Werten **Mündliche Note** (aus den
  Unterrichtsleistungen), **Schriftliche Note** (aus den Klausuren) und
  **Gesamtnote**.
- Darunter zwei **Reiter** (nebeneinander liegende Buttons) „Klausuren" und
  „Unterrichtsleistungen". In jedem Reiter können Klausuren/ULs angelegt
  werden; jede bekommt eine eigene Tabelle mit allen Schüler/innen zur
  Punkteeingabe. Die daraus berechnete Note fließt live (ohne Neuladen) in
  die Notenübersicht oben.

### Notenbesprechungsmodus

Über „🗣 Notenbesprechung starten" auf der Noteneingabe-Seite gelangt man in
einen Modus, der immer nur **eine** Schüler/in mit ihren/seinen Noten,
Punkten und Klausuren/ULs zeigt. Mit „← Zurück" / „Weiter →" wechselt man
zur vorherigen/nächsten Schüler/in (alphabetisch). Jede Schüler/in bekommt
ein Notizfeld — Einträge werden als Verlauf gespeichert (nicht
überschrieben), wahlweise als **Notenbesprechung** (an das aktuelle Fach
gebunden) oder als **Notenkonferenz-Entscheidung** (klassenweit, fachübergreifend
sichtbar). Alle Notizen einer Schüler/in erscheinen in der
Halbjahresübersicht der Klassenleitung.

## Deployment auf Plesk (noten.bbz-rd-eck.com)

Plesk-Web-Admin-Edition hat **kein** Python/Passenger für Flask. Wir nutzen
Plesks **Node.js-Support** (Phusion Passenger) — der ist vorhanden.
Der Deploy läuft vollständig über die Plesk-Web-UI, **kein** SSH nötig.

> **Wichtig:** Die App startet Plesk selbst. Du musst nichts manuell auf der
> Kommandozeile starten. Das einzige, was laufen muss, ist `npm install` in der
> Plesk-Node.js-UI, damit die Abhängigkeiten vorhanden sind.

### 1. Git-Repository in Plesk verknüpfen (einmalig)

1. Plesk → `noten.bbz-rd-eck.com` → **Git** → **Repository hinzufügen**
2. **URL:** `git@github.com:deraal09/noten_webapp.git` (oder euer Fork)
3. **Verzweigung:** `devel`
4. Plesk zeigt einen Public-Key an — den bei GitHub als **Deploy-Key**
   mit **Read-Only**-Zugriff eintragen
5. **Bereitstellung:** „Verzweigung devel automatisch zu /noten.bbz-rd-eck.com"
   aktivieren → ab jetzt läuft Auto-Deploy nach jedem `git push`

### 2. Node.js in Plesk aktivieren (einmalig)

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **Anwendungs-Wurzel:** das Verzeichnis mit `app.js` (i. d. R. das Repo-Root)
3. **Anwendungs-Startdatei:** `app.js`
4. **Anwendungsmodus:** `production`

Plesk/Passenger weist der App automatisch einen Port **oder einen Unix-Socket**
zu und konfiguriert nginx dorthin. `app.js` erkennt beides automatisch
(`PORT` numerisch → TCP-Port, sonst → Socket-Pfad).

### 3. Umgebungsvariablen setzen (in Plesk-UI)

| Variable      | Wert                                            |
|---------------|-------------------------------------------------|
| `NODE_ENV`    | `production`                                    |
| `SECRET`      | 64+ zufällige Zeichen (z. B. `openssl rand -hex 32`) |
| `PUBLIC_URL`  | `https://noten.bbz-rd-eck.com`                  |
| `DB_PFAD`     | (optional, Default: `data/noten.sqlite3`)       |

Wichtig: `SECRET` ist das Session-Secret — wenn die App neu gestartet
wird, werden alle Sessions ungültig, wenn du es änderst.
**Fehlt `SECRET`, beendet sich die App sofort mit Exit 1** → Symptom ist
dann **504** auf jedem Request.

> **⚠ Natives Modul `better-sqlite3`:** Wird beim Install **gegen die
> Node-Version der Subdomain kompiliert** (node-gyp). Voraussetzungen
> auf dem Server: `python3`, `make`, `g++`/build-essential. **Wenn
> später die Node-Version in der Plesk-UI gewechselt wird, muss
> `npm rebuild better-sqlite3` (oder erneut `npm ci`) laufen**.

### 4. Dependencies installieren (über Plesk-UI)

Plesk → Node.js → **„npm-Installation"** klicken. Damit wird
`npm install` (mit dem aktuellen `package.json`) ausgeführt. Beim
ersten Mal und nach jeder Änderung an `package(-lock).json` nötig.
Idempotent — mehrfaches Klicken schadet nicht.

### 5. App starten / neu starten (Plesk-Node.js-UI)

Die App wird **nicht** per Hand auf der Shell gestartet. Plesk übernimmt das:

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. Prüfen, dass dort steht:
   - **Anwendungs-Startdatei:** `app.js`
   - **Anwendungsmodus:** `production`
   - **Dokumentenstamm:** (Standard, wird von Plesk verwaltet)
3. **„Anwendung neu starten"** klicken
4. Warte ein paar Sekunden, dann im Browser testen:
   ```
   https://noten.bbz-rd-eck.com/
   ```

Nach jedem `git push` oder wenn sich `package.json`/`package-lock.json`
geändert hat: **„npm-Installation"** → **„Anwendung neu starten"**.

**Automatischer Neustart über Plesk-Bereitstellungsaktionen:** Eine
Bereitstellungsaktion mit
`export PATH=/opt/plesk/node/22/bin:$PATH && npm install && touch tmp/restart.txt`
übernimmt beides automatisch nach jedem Git-Pull — `touch tmp/restart.txt`
ist Passengers Standard-Mechanismus, um die App beim nächsten Request neu zu
starten. Ein manueller Klick auf „Anwendung neu starten" ist damit i. d. R.
NICHT nötig. Einzige Voraussetzung: das Verzeichnis `tmp/` muss existieren
(es ist in `.gitignore`, wird also nicht mitgeklont) — sicherheitshalber die
Aktion auf `mkdir -p tmp && touch tmp/restart.txt` erweitern, damit der
Befehl auch beim allerersten Deploy nicht mit „No such file or directory"
fehlschlägt.

### 6. Ersten Admin anlegen

Nach dem ersten Start:
```
https://noten.bbz-rd-eck.com/setup
```

Oder per CLI auf dem Server (per SSH als `root@noten.bbz-rd-eck.com`):
```bash
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
node src/cli/seed-admin.js --username admin --display "Dein Name"
```

### 7. Fehlerbehebung

Bei wiederholtem 504:
- App-Log prüfen: `tail -50 logs/stderr.log` (oder `tmp/stderr.log`)
- Plesk-UI → Node.js → **„Anwendung neu starten"**
- ENV-Variablen `SECRET` und `NODE_ENV=production` in Plesk-UI
  kontrollieren (fehlt `SECRET`, beendet sich die App sofort mit Exit 1)

## Verzeichnisstruktur

```
webapp/
├── app.js              # Einstiegspunkt (Plesk-Node ruft das auf)
├── package.json
├── src/
│   ├── auth.js         # Session, Passwort-Hashing, Permission-Checks
│   ├── db.js           # better-sqlite3-Setup + Schema
│   ├── grade-calc.js   # Notenberechnung (portiert aus grade_calc.py)
│   ├── routes/
│   │   ├── auth.js     # /login, /logout, /setup, /einladung/<token>
│   │   ├── admin.js    # Schuljahre, Klassen, Schüler, Fächer, …
│   │   ├── teacher.js  # Notentafel, Klausuren, ULs, AJAX-API
│   │   ├── klassenlehrer.js  # Fehlzeiten
│   │   └── export.js   # CSV-Export
│   └── cli/
│       └── seed-admin.js
├── views/              # EJS-Templates
│   ├── auth/
│   ├── admin/
│   ├── teacher/
│   ├── klassenlehrer/
│   └── partials/layout.ejs
├── static/css/app.css
├── scripts/
│   └── build.js        # Pre-Deploy-Check (package.json, Syntax, Views)
├── test/
│   ├── grade-calc.test.js
│   └── e2e.test.js
└── data/               # SQLite-Datei (nicht ins Repo!)
```

## ENV-Variablen

| Variable      | Default                       | Bedeutung                          |
|---------------|-------------------------------|------------------------------------|
| `PORT`        | `3001` (lokal)                | Plesk/Passenger setzt selbst – Zahl ODER Socket-Pfad |
| `HOST`        | `0.0.0.0`                     | Bind-Adresse (nur bei TCP-Port)    |
| `SECRET`      | (zwingend in Produktion)      | Session-Secret (≥32 Zeichen)       |
| `DB_PFAD`     | `data/noten.sqlite3`          | Pfad zur SQLite-Datei              |
| `PUBLIC_URL`  | `http(s)://Host:Port`         | Basis-URL für Einladungslinks      |
| `NODE_ENV`    | (nicht gesetzt)               | `production` für kompaktes Logging |

## Backup

Nur die Datei `data/noten.sqlite3` muss gesichert werden. Sie enthält
alle Schuljahre, Klassen, Schüler/innen, Fächer, Noten und Fehlzeiten.

```bash
# Plesk-UI → Backup-Manager → Datenbank-Dateien einschließen
# Oder per Cron:
cp /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/data/noten.sqlite3 \
   /backup/noten-$(date +%Y%m%d).sqlite3
```

## Architektur-Wechsel: warum?

Die alte Webapp-Version basierte auf Python/Flask + gunicorn + Node.js-Proxy
als Workaround für Plesks fehlenden Python-Support. Das verursachte
ständig Konflikte (Gogs auf Port 3000, Plesks nginx-Override,
Doppel-Proxy-Stack).

Mit dem hier vorliegenden Rewrite läuft die App als **ein** Node.js-Prozess
direkt unter Plesks Node.js-Support. **Kein** Reverse-Proxy, **kein**
gunicorn, **kein** zweiter Port, **kein** nginx-Override.

## Wartung / Updates

Plesk Web Admin trennt Git-Repo und Node.js-App in zwei voneinander
unabhängige UIs. Der Deploy läuft deshalb vollständig über die Plesk-Oberfläche:

1. Lokal: `npm run build` → `npm test` → `git push origin devel`
2. Plesk Git: Auto-Deploy pullt `devel` (oder manuell „Jetzt Pull ausführen")
3. Plesk Node.js: **„npm-Installation"** → **„App neu starten"**

### Häufige Fehler nach Deploy

- **500 Internal Server Error** → App-Code wirft unbehandelten Fehler.
  **App-Log auslesen** (Plesk-Dateimanager → `logs/stderr.log` oder
  `tmp/stderr.log`), Stacktrace suchen.
- **504 Gateway Timeout** → fast immer `SECRET` fehlt oder < 32 Zeichen in
  der Plesk-Node.js-UI → App beendet sich sofort. App-Log prüfen.
- **„Die Anwendung wird nach der ersten Anfrage neu gestartet"** (grünes
  Banner) → **kein Fehler**, das ist Passengers Restart-Hinweis.
- **App hängt im Restart-Loop** → Plesk → Node.js → „App neu starten"
  klicken, dann Log sichten.

### Rollback

`git revert <bad-sha> && git push origin devel` → Auto-Deploy läuft mit
dem alten Stand. Bei DB-Migrationen: `SCHEMA_VERSION` in `src/db.js`
beachten — Migrationen sind nicht automatisch rückwärtskompatibel.

### Verfügbare Skripte im Überblick

| `npm run …` | Zweck                              |
|-------------|------------------------------------|
| `start`     | App starten                        |
| `dev`       | App mit Auto-Reload starten        |
| `build`     | Pre-Deploy-Check                   |
| `test`      | Tests ausführen                    |
| `seed:admin`| Admin per CLI anlegen              |

## Dark Mode

Die App folgt automatisch der Betriebssystem-/Browser-Einstellung
(`prefers-color-scheme`) — kein manueller Umschalter, kein JavaScript nötig.
Alle Farben in `static/css/app.css` sind als CSS-Variablen in `:root`
definiert; ein `@media (prefers-color-scheme: dark) { :root { ... } }`-Block
überschreibt sie für den Dark Mode. Neue Styles sollten `var(--…)` statt
fester Hex-Farben verwenden, damit sie in beiden Modi funktionieren.

## Entwicklung

```bash
# Auto-Reload während der Entwicklung
npm run dev

# Tests
npm test

# Lint / Typecheck
# (dieses Projekt nutzt bewusst kein TypeScript und keinen Linter,
#  um die Komplexität gering zu halten)
```
