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
