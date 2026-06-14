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
| Frontend    | Vanilla CSS (kein CDN, keine Build-Pipeline) |

## Funktionen

- **Rollen:** Admin / Lehrkraft / Klassenleitung
- **Setup:** Beim ersten Start wird der erste Admin via `/setup` angelegt
- **Einladungssystem:** Admin erzeugt Einladungslinks, Lehrkräfte wählen
  selbst Benutzername + Passwort
- **Notenverwaltung:** Klausuren, Unterrichtsleistungen (ULs), mündlich/schriftlich,
  mit automatischer Gewichtung
- **Notentafel:** Live-Gesamtnoten via AJAX
- **Fehlzeiten:** Pro Halbjahr, drei Typen (entschuldigt/unentschuldigt/betrieblich)
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

## Deployment auf Plesk (noten.bbz-rd-eck.com)

> **Vollständiges Runbook mit Screenshots:** [`docs/DEPLOY.md`](docs/DEPLOY.md).
> Diese Sektion ist die kompakte Erst-Setup-Anleitung.

Plesk-Web-Admin-Edition hat **kein** Python/Passenger für Flask. Wir nutzen
Plesks **Node.js-Support** (Phusion Passenger) — der ist vorhanden.
Plesk-Web-Admin trennt **Git-Repository** und **Node.js-App** in zwei
voneinander unabhängige UIs ohne Querzugriff. Wir nutzen beide — der
Deploy läuft vollständig über die Plesk-Web-UI, **kein** SSH nötig.

### 1. Git-Repository in Plesk verknüpfen (einmalig)

1. Plesk → `noten.bbz-rd-eck.com` → **Git** → **Repository hinzufügen**
2. **URL:** `git@github.com:deraal09/noten_webapp.git` (oder euer Fork)
3. **Verzweigung:** `devel`
4. Plesk zeigt einen Public-Key an — den bei GitHub als **Deploy-Key**
   mit **Read-Only**-Zugriff eintragen
5. **Bereitstellung:** „Verzweigung devel automatisch zu /noten.bbz-rd-eck.com"
   aktivieren → ab jetzt läuft Auto-Deploy nach jedem `git push`

> Alternativ (per SSH als `root@noten.bbz-rd-eck.com`): `cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/ && git clone <repo-url> .`
> im Application-Root. Beide Wege führen zum selben Endstand.

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
> `npm rebuild better-sqlite3` (oder erneut `npm ci`) laufen**,
> sonst meldet die App beim Start einen ABI-/Modulfehler. Dieser
> Schritt passiert automatisch in Phase 3 des Deploy-Flows
> (`deploy:plesk-server` → `npm ci --omit=dev`).

### 4. Dependencies installieren (über Plesk-UI)

Plesk → Node.js → **„npm-Installation"** klicken. Damit wird
`npm install` (mit dem aktuellen `package.json`) ausgeführt. Beim
ersten Mal und nach jeder Änderung an `package(-lock).json` nötig.
Idempotent — mehrfaches Klicken schadet nicht.

> Für die Erst-Installation und nach Dependency-Änderungen genügt auch
> der Deploy-Flow über `deploy:plesk-server` — der führt `npm ci
> --omit=dev` aus (reproduzierbar, schneller).

### 5. Ersten Admin anlegen

Nach dem ersten Start:
```
https://noten.bbz-rd-eck.com/setup
```

Oder per CLI auf dem Server (per SSH als `root@noten.bbz-rd-eck.com`):
```bash
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
node src/cli/seed-admin.js --username admin --display "Dein Name"
```

### 6. Alte Workarounds löschen (Plesk-Cleanup, nur Notfall)

Falls die App frisch deployed wird und noch **Überreste vom alten
Python/Passenger-Setup** auf dem Server liegen, schlägt Plesks
Node.js-Handler nicht auf — Symptom: nginx liefert **504 Gateway
Timeout**, obwohl die App intern auf Port 3001 mit 302 antwortet.
Ursache ist in der Regel eine Apache-vhost-Snippet für Passenger
(`proxy_pass` zeigt noch auf einen alten Port, oder `.htaccess`
aktiviert Passenger-Modi).

**Lösung:** Das beigelegte Skript räumt auf und regeneriert den
Plesk-vhost. Braucht SSH + root-Zugriff, lässt sich **nicht** über die
Plesk-UI ausführen:

```bash
ssh root@noten.bbz-rd-eck.com
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
git pull                                # scripts/plesk-cleanup.sh mitziehen
bash scripts/plesk-cleanup.sh          # kein sudo nötig, du bist schon root
# oder via npm:
npm run deploy:plesk
```

Das Skript löscht `passenger_wsgi.py`, `wsgi.py`, `.htaccess`,
`__pycache__/`, `instance/`, `venv/`, ruft `plesk repair web` und
startet die Node.js-Anwendung neu. Anschließend verifiziert es die
Erreichbarkeit intern (Port 3001) und extern (`https://noten.bbz-rd-eck.com`).

Bei wiederholtem 504 nach dem Cleanup:
- App-Log prüfen: `tail -50 logs/stderr.log` (oder `tmp/stderr.log`)
- Plesk-UI → Node.js → **„Anwendung neu starten"**
- ENV-Variablen `SECRET` und `NODE_ENV=production` in Plesk-UI
  kontrollieren (fehlt `SECRET`, beendet sich die App sofort mit Exit 1)

## Verzeichnisstruktur

```
webapp/
├── app.js              # Einstiegspunkt (Plesk-Node ruft das auf)
├── package.json
├── docs/
│   └── DEPLOY.md       # Runbook für Plesk-UI-Deploy
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
├── scripts/            # Deploy-Helfer (LOKAL + SERVER über Plesk-UI)
│   ├── preflight.sh
│   ├── plesk-server.sh
│   ├── post-deploy-verify.sh
│   ├── deploy.sh       # Legacy: SSH-deploy
│   └── plesk-cleanup.sh # Notfall: 504-Fix, braucht sudo
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

> **Vollständiges Runbook mit Screenshots-Bezug:** [`docs/DEPLOY.md`](docs/DEPLOY.md).

Plesk Web Admin trennt Git-Repo und Node.js-App in zwei voneinander
unabhängige UIs. Der Deploy ist deshalb ein 4-Phasen-Flow — alle Phasen
nutzen nur Tools, die direkt in Plesk verfügbar sind, **kein** SSH nötig.
Grundprinzip: **„no magic, manual steps"** — jede Phase ist auch am
Telefon erklärbar.

| Phase | Wo          | Befehl / Klick                                                |
|-------|-------------|---------------------------------------------------------------|
| 1     | LOKAL       | `npm run deploy:preflight` → `git push origin devel`           |
| 2     | Plesk Git   | Auto-Deploy (oder „Jetzt Pull ausführen" klicken)             |
| 3     | Plesk Node  | **Primärweg:** „npm-Installation" → „App neu starten" (2 Klicks) |
| 4     | LOKAL       | `npm run deploy:verify` (optional)                            |

**Phase 3 — Primärweg (2 separate UI-Klicks):**
1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **„npm-Installation"** klicken → warten auf grünes ✓
3. **„App neu starten"** klicken → warten auf grünes „Restart queued"-Banner

Das ist der **empfohlene Pfad** — zwei Klicks, kein Skript, jederzeit wiederholbar.

**Phase 3 — Optionaler Shortcut (1 Klick über Custom-Skript):**

Wenn du in `package.json` das Custom-Skript `deploy:plesk-server` hast
(siehe `scripts/plesk-server.sh`), kannst du Schritt 2 + 3 zusammenlegen:
1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **„Skript ausführen"** klicken
3. In das Textfeld **`deploy:plesk-server`** eintippen (= `npm run deploy:plesk-server`)
4. **„Ausführen"** klicken

> **„Skript ausführen" ist ein Freitext-Feld** (nicht ein Dropdown, nicht
> ein Shell): Plesk führt `npm run <Eingabe>` aus. Tippst du `start`,
> läuft `npm start`. Tippst du `deploy:plesk-server`, läuft das
> Custom-Skript aus `package.json`. **Git läuft hier NICHT** — das ist
> Sache der Plesk-Git-UI.

```bash
# LOKAL vor dem Push — Tests grün, Branch & Remote geprüft
npm run deploy:preflight
git push origin devel
```

```bash
# LOKAL nach dem Deploy — Health-Check der Public-URL
npm run deploy:verify
```

### Häufige Fehler nach Deploy

- **500 Internal Server Error** → App-Code wirft unbehandelten Fehler.
  **App-Log auslesen** (Plesk-Dateimanager → `logs/stderr.log` oder
  `tmp/stderr.log`), Stacktrace suchen. Hat mit dem Deploy-Workflow meist
  nichts zu tun, wenn der App-Code selbst unverändert ist.
- **504 Gateway Timeout** → fast immer `SECRET` fehlt oder < 32 Zeichen in
  der Plesk-Node.js-UI → App beendet sich sofort. App-Log prüfen.
- **„Die Anwendung wird nach der ersten Anfrage neu gestartet"** (grünes
  Banner) → **kein Fehler**, das ist Passengers Restart-Hinweis.
- **App hängt im Restart-Loop** → Plesk → Node.js → „App neu starten"
  klicken, dann Log sichten.
- **„Skript ausführen" meldet „git kann nicht ausgeführt werden"** → das
  Custom-Skript ruft nirgends git auf; Ursache ist upstream (Plesks
  Working-Copy-Prüfung). **Auf den Primärweg (2 Klicks) ausweichen.**
- **Erst-Deploy / Konflikt mit altem Python-Setup** (selten) →
  `sudo bash scripts/plesk-cleanup.sh` per SSH — siehe §6 oben.

### Rollback

`git revert <bad-sha> && git push origin devel` → Auto-Deploy läuft mit
dem alten Stand. Bei DB-Migrationen: `SCHEMA_VERSION` in `src/db.js`
beachten — Migrationen sind nicht automatisch rückwärtskompatibel.

### Verfügbare Skripte im Überblick

| `npm run …`              | Wo          | Zweck                                                       |
|--------------------------|-------------|-------------------------------------------------------------|
| `deploy:preflight`       | LOKAL       | Tests + Branch-/Remote-Check vor `git push`                 |
| `deploy:verify`          | LOKAL       | curl-Check der Public-URL (optional, nach Deploy)           |
| `deploy:plesk-server`    | SERVER (UI) | Optionaler Shortcut: `npm ci` + Restart in einem Klick      |
| `deploy` (Legacy)        | SERVER (SSH)| `git pull` + `npm ci` + Restart — **nicht** auf Plesk Web Admin |
| `deploy:plesk` (Notfall) | SERVER (SSH)| 504-Fix mit `sudo` — braucht root, nicht via UI möglich     |

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
