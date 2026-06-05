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
cd webapp
npm install
npm start         # → http://localhost:3000
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

Plesk-Web-Admin-Edition hat **kein** Python/Passenger. Wir nutzen einfach
Plesks **Node.js-Support** — der ist da.

### 1. Dateien hochladen

Per SSH oder Plesk-Dateimanager den **Inhalt** von `webapp/` (ohne
`node_modules/`, ohne `data/`) in das Application-Root der Subdomain
hochladen, z. B.:

```
/var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
```

### 2. Dependencies installieren (auf dem Server)

```bash
ssh ci_cd_account@noten.bbz-rd-eck.com
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
npm install --omit=dev
```

Falls `npm install` Probleme macht (z. B. `Cannot find module 'semver'`):
```bash
# Schneller Workaround: npm neu installieren
npm install -g npm@latest
```

Oder: Auf dem Server in `node_modules/` leere Platzhalter-Dateien anlegen
und die `.js`-Dateien aus einem funktionierenden `node_modules` reinkopieren.
**Aber:** Plesk-Web-Admin sollte Node.js unterstützen, `npm install` ist
normalerweise problemlos möglich.

### 3. Plesk-UI: Node.js aktivieren

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **Anwendungs-Wurzel:** `httpdocs` (oder wo der Code liegt)
3. **Anwendungs-Startdatei:** `app.js`
4. **„Anwendung neu starten"** klicken
5. Status sollte **„running"** werden

Plesk weist der App automatisch einen Port zu (nicht 3000 — der ist
meistens von Gogs belegt) und konfiguriert nginx dorthin. **Kein**
Reverse-Proxy, **kein** gunicorn.

### 4. Umgebungsvariablen setzen (in Plesk-UI)

| Variable      | Wert                                            |
|---------------|-------------------------------------------------|
| `NODE_ENV`    | `production`                                    |
| `SECRET`      | 64+ zufällige Zeichen (z. B. `openssl rand -hex 32`) |
| `PUBLIC_URL`  | `https://noten.bbz-rd-eck.com`                  |
| `DB_PFAD`     | (optional, Default: `data/noten.sqlite3`)       |

Wichtig: `SECRET` ist das Session-Secret — wenn die App neu gestartet
wird, werden alle Sessions ungültig, wenn du es änderst.

### 5. Ersten Admin anlegen

Nach dem ersten Start:
```
https://noten.bbz-rd-eck.com/setup
```

Oder per CLI auf dem Server:
```bash
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
node src/cli/seed-admin.js --username admin --display "Dein Name"
```

### 6. Alte Workarounds löschen

Falls noch Dateien vom alten Python-Setup existieren, löschen:
```bash
rm -f passenger_wsgi.py wsgi.py .htaccess
rm -rf __pycache__ instance venv
```

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
├── test/
│   ├── grade-calc.test.js
│   └── e2e.test.js
└── data/               # SQLite-Datei (nicht ins Repo!)
```

## ENV-Variablen

| Variable      | Default                       | Bedeutung                          |
|---------------|-------------------------------|------------------------------------|
| `PORT`        | `3000`                        | Server-Port (Plesk setzt selbst)   |
| `HOST`        | `0.0.0.0`                     | Bind-Adresse                       |
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

```bash
ssh ci_cd_account@noten.bbz-rd-eck.com
cd /var/www/vhosts/bbz-rd-eck.com/noten.bbz-rd-eck.com/
git pull                                # neue Files
npm install --omit=dev                  # falls package.json geändert
# Plesk-UI → Node.js → "Anwendung neu starten"
```

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
