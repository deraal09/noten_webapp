# Deployment-Workflow (Plesk Web Admin Edition)

> Schritt-für-Schritt-Runbook für den Deploy auf `noten.bbz-rd-eck.com`.
> Lese auch: [`QWEN.md`](../QWEN.md) §„Deployment-Workflow (Plesk Web Admin)".

Plesk Web Admin trennt **Git-Repository-Verwaltung** und **Node.js-App-Verwaltung**
in zwei voneinander unabhängige UIs. Beide haben keinen Zugriff aufeinander — der
Deploy läuft deshalb als bewusst simpler, fragmentierter 4-Phasen-Flow mit
drei Beteiligten (Entwicklermaschine, Plesk-Git-UI, Plesk-Node.js-UI).

**Grundprinzip: „no magic, manual steps".** Jede Phase hat eine klare Aufgabe
und lässt sich von einer zweiten Person am Telefon durchführen. Es gibt
keinen geheimen Klick, kein Auto-Magic, keine Schritte, die nur lokal
sichtbar sind.

## Übersicht

```
┌──────────────┐    ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────┐
│ LOKAL        │    │ Plesk Git UI        │    │ Plesk Node.js UI    │    │ LOKAL        │
│              │    │                     │    │                     │    │              │
│ deploy:      │ →  │ "Jetzt Pull         │ →  │ Phase 3:            │ →  │ deploy:      │
│ preflight +  │    │  ausführen"         │    │  2 separate Klicks  │    │ verify       │
│ git push     │    │ (oder Auto-Deploy)  │    │  (npm-Install +     │    │ (optional)   │
│              │    │                     │    │   App neu starten)  │    │              │
└──────────────┘    └─────────────────────┘    │  ──── ODER ────     │    └──────────────┘
    Phase 1              Phase 2              │  1 Klick:           │
                                              │  "Skript ausführen" │
                                              │  → deploy:plesk-    │
                                              │    server           │
                                              └─────────────────────┘
                                                  Phase 3
```

## Voraussetzungen (einmalig)

### A. Plesk → Git-Repository verknüpfen
1. Plesk → `noten.bbz-rd-eck.com` → **Git**
2. Repository hinzufügen:
   - **URL:** `git@github.com:deraal09/noten_webapp.git`
   - **Verzweigung:** `devel`
3. SSH-Key hinterlegen (Plesk fordert dich auf, einen Public-Key anzuzeigen — den
   bei GitHub als **Deploy-Key** mit Read-Only-Zugriff eintragen).
4. **Bereitstellung:** „Verzweigung devel automatisch zu /noten.bbz-rd-eck.com"
   aktivieren → Phase 2 entfällt danach automatisch nach `git push`.

### B. Plesk → Node.js konfigurieren
1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **Anwendungs-Wurzel:** `/noten.bbz-rd-eck.com` (= Repo-Root, dort liegt `app.js`)
3. **Anwendungs-Startdatei:** `app.js`
4. **Anwendungsmodus:** `production`
5. **Umgebungsvariablen** (zwingend):

   | Variable      | Wert                                            |
   |---------------|-------------------------------------------------|
   | `NODE_ENV`    | `production`                                    |
   | `SECRET`      | 64+ zufällige Zeichen (`openssl rand -hex 32`)  |
   | `PUBLIC_URL`  | `https://noten.bbz-rd-eck.com`                  |

6. Plesk → Node.js → **„App neu starten"** (Initialstart, danach Phase 3 übernehmen).

## Phase 1 — LOKAL: testen + pushen

```bash
npm run deploy:preflight
# → Tests laufen, Working-Tree geprüft, Branch geprüft, Remote geprüft
# → Bricht ab, wenn npm test fehlschlägt (Exit 1)
```

Ausgabe zeigt am Ende die nächsten 4 Schritte. Wenn alles grün ist:

```bash
git push origin devel
```

> **Wichtig:** Nur Push auf `devel` triggert Plesk-Auto-Deploy. Andere Branches
> werden von Plesk ignoriert.

## Phase 2 — Plesk Git UI: Pull

**Wenn Auto-Deploy aktiv (empfohlen):** entfällt — Plesk pullt `devel` nach
jedem `git push` automatisch. In der Git-UI siehst du den frischen Commit unter
„Neueste Commits".

**Sonst manuell:**
1. Plesk → `noten.bbz-rd-eck.com` → **Git**
2. Bei `noten_webapp.git` → **„Jetzt Pull ausführen"** klicken
3. Warten, bis der Balken grün ist und dein Commit oben in „Neueste Commits" steht

> **Diese Phase ist getrennt von der Node.js-UI.** Die Node.js-UI kann und
> wird kein `git pull` ausführen — die beiden Panels haben keinerlei
> Querzugriff. Git-Operationen laufen **immer** über die Git-UI.

## Phase 3 — Plesk Node.js UI: installieren + neustarten

**Primärweg (manuell, 2 Klicks):**

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **„npm-Installation"** klicken → wartet kurz, bis grünes ✓ erscheint
3. **„App neu starten"** klicken → wartet, bis „Die Anwendung wird nach der
   ersten Anfrage neu gestartet" (grünes Banner) erscheint

Das ist der **empfohlene Pfad** — zwei UI-Klicks, vollständig transparent,
jederzeit wiederholbar, kein Skript im Spiel.

**Optional (1 Klick über `deploy:plesk-server`):**

Wenn du in `package.json` das Custom-Skript `deploy:plesk-server` hast
(siehe `scripts/plesk-server.sh`), kannst du Schritt 2 + 3 zusammenlegen:

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **„Skript ausführen"** klicken
3. In das Textfeld **`deploy:plesk-server`** eintippen (= `npm run deploy:plesk-server`)
4. **„Ausführen"** klicken

Das Skript führt dann `npm ci --omit=dev` + `touch tmp/restart.txt` +
internen Health-Check aus. Spart **einen** Klick.

> **Wichtig zu „Skript ausführen":** Es ist ein **Freitext-Feld**, das
> `npm run <Eingabe>` ausführt — kein Shell, kein `cd`, kein `&&`, keine
> Environment-Overrides. Wenn du `start` eintippst, läuft `npm start` →
> `node app.js`. Tippst du `deploy:plesk-server`, läuft das Custom-Skript
> aus `package.json`. **Git wird hier nicht ausgeführt** — das ist
> ausschließlich Sache der Git-UI.

## Phase 4 — LOKAL: verifizieren (optional)

```bash
npm run deploy:verify
# → prüft https://noten.bbz-rd-eck.com/login + /setup
# → exit 0 = ok, exit 1 = Problem
```

Erwartete Ausgabe:
```
[verify] 1/3 — https://noten.bbz-rd-eck.com/login …
  ✓ /login → HTTP 200 (oder 302)
[verify] 2/3 — https://noten.bbz-rd-eck.com/setup …
  ✓ /setup → HTTP 200 (oder 302)
[verify] 3/3 — interner Check 127.0.0.1:3001/login …
  ✓ 127.0.0.1:3001/login → HTTP 200
Deploy-Verifizierung ok.
```

`HTTP 302` ist normal (Login- Redirect auf /login → /setup oder /dashboard).
Phase 4 ist optional — am schnellsten geht die Verifizierung im Browser
(`https://noten.bbz-rd-eck.com/login`).

## Häufige Fehlerbilder

### 500 Internal Server Error nach Deploy
**Wahrscheinlichste Ursache:** App-Code wirft unbehandelten Fehler. Da wir
App-Code in diesem Push nicht geändert haben (nur `package.json`, neue Skripte,
Doku), ist die Ursache meist **nicht** der letzte Deploy.

→ App-Log auslesen (Plesk-Dateimanager):
  `logs/stderr.log` oder `tmp/stderr.log` (was neuer ist) → letzte 30–50 Zeilen
→ Suche nach `Error`, `TypeError`, `Cannot find module`, Stacktraces

### 504 Gateway Timeout nach Deploy
**Ursache 1: SECRET fehlt oder zu kurz** (App crashed beim Start)
→ Plesk → Node.js → Umgebungsvariablen: `SECRET` muss ≥ 32 Zeichen sein.
→ App-Log prüfen: steht dort
  `FEHLER: ENV-Variable SECRET muss in Produktion gesetzt sein`?

**Ursache 2: App hängt im Crash-Loop**
→ Plesk → Node.js → **„App neu starten"** und Log erneut sichten.

**Ursache 3: Plesk-Git-UI hat den Pull nicht durchgeführt**
→ Phase 2 noch einmal manuell triggern, dann Phase 3.

### 502 Bad Gateway
**Ursache:** Apache/nginx kann die Node-App auf ihrem internen Port nicht
erreichen. Fast immer ein Konfigurationsproblem, nicht ein App-Problem.
→ `sudo bash scripts/plesk-cleanup.sh` auf dem Server (per SSH) — siehe
  README §6. Danach `npm run deploy:plesk` analog (alte Skripte, SSH-basiert).

### 404 Not Found auf statische Assets (CSS fehlt)
**Ursache:** `node_modules/@fastify/static` wurde nicht installiert.
→ Phase 3 wiederholen (oder `npm ci --omit=dev` manuell anstoßen).

### „Die Anwendung wird nach der ersten Anfrage neu gestartet" (grünes Banner)
**Kein Fehler** — das ist Passengers „Restart queued"-Hinweis. Verschwindet,
sobald der erste Request eintrifft.

### „git kann nicht ausgeführt werden" in der Skript-Ausgabe
**Das Custom-Skript `plesk-server.sh` ruft nirgends `git` auf.** Wenn diese
Meldung von Plesks Node.js-UI kommt, ist die Ursache upstream — Plesk
prüft vermutlich vor Skript-Start, ob die Working-Copy sauber ist. Mögliche
Fixes:
1. **Plesk-Git-UI öffnen** und prüfen, ob das Repo verbunden ist und der
   letzte Pull grün war
2. **Phase 2 manuell wiederholen** („Jetzt Pull ausführen")
3. **Auf den manuellen Primärweg ausweichen** (Phase 3 oben: 2 Klicks
   `npm-Installation` + `App neu starten` statt Custom-Skript)

## Rollback

Plesk-Git-UI hat keinen eingebauten Rollback-Button. Workarounds:

1. **Schnell:** `git revert <bad-commit-sha> && git push origin devel` →
   Auto-Deploy läuft, Phase 3 → Phase 4.
2. **Auf alten Commit zurücksetzen:** in Plesk-Git-UI den Branch auf einen
   früheren Commit umstellen (in der Repo-Verwaltung „Reset"-Funktion, falls
   vorhanden), dann Phase 3 + 4.

> **Datenmigrationen sind nicht automatisch rückwärtskompatibel** — vor
> einem Rollback immer prüfen, ob die DB-Version im Ziel-Commit mit der
> aktuellen `data/noten.sqlite3` verträglich ist. `SCHEMA_VERSION` in
> `src/db.js` beachten.

## Verwandte Skripte (im Repo)

| Skript                          | Wo ausführen  | Zweck                                          |
|---------------------------------|---------------|------------------------------------------------|
| `scripts/preflight.sh`          | LOKAL         | Tests + Branch-Check vor `git push`            |
| `scripts/plesk-server.sh`       | SERVER (UI)   | Optional: `npm ci + restart` in einem Klick    |
| `scripts/post-deploy-verify.sh` | LOKAL         | curl-Check der Public-URL                      |
| `scripts/deploy.sh`             | SERVER (SSH)  | Legacy: git pull + npm ci + restart (siehe Header) |
| `scripts/plesk-cleanup.sh`      | SERVER (SSH)  | Notfall: 504-Fix (sudo, braucht root)          |

`scripts/deploy.sh` (Legacy) funktioniert auf Plesk Web Admin **nicht** —
braucht `git` und SSH-Zugriff, die hier nicht gegeben sind. Ist nur noch
als historische Referenz im Repo.
