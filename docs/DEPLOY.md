# Deployment-Workflow (Plesk Web Admin Edition)

> Schritt-für-Schritt-Runbook für den Deploy auf `noten.bbz-rd-eck.com`.
> Lese auch: [`QWEN.md`](../QWEN.md) §„Deployment-Workflow (Plesk Web Admin)".

Plesk Web Admin trennt **Git-Repository-Verwaltung** und **Node.js-App-Verwaltung**
in zwei voneinander unabhängige UIs. Beide haben keinen Zugriff aufeinander — der
Deploy ist deshalb ein 4-Phasen-Flow, an dem drei Werkzeuge beteiligt sind
(Entwicklermaschine, Plesk-Git-UI, Plesk-Node.js-UI).

## Übersicht

```
┌──────────────┐    ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────┐
│ LOKAL        │    │ Plesk Git UI        │    │ Plesk Node.js UI    │    │ LOKAL/SERVER │
│              │    │                     │    │                     │    │              │
│ deploy:      │ →  │ "Jetzt Pull         │ →  │ "Skript ausführen"  │ →  │ deploy:      │
│ preflight +  │    │  ausführen"         │    │  → deploy:plesk-    │    │ verify       │
│ git push     │    │ (oder Auto-Deploy)  │    │  server             │    │              │
└──────────────┘    └─────────────────────┘    └─────────────────────┘    └──────────────┘
    Phase 1              Phase 2                   Phase 3                  Phase 4
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

## Phase 3 — Plesk Node.js UI: deploy:plesk-server

Dieser Schritt macht in **einem** Klick: `npm ci --omit=dev` + Passenger-Restart
+ interner Health-Check. Das spart 2 separate UI-Klicks gegenüber dem
expliziten „npm-Installation" + „App neu starten".

1. Plesk → `noten.bbz-rd-eck.com` → **Node.js**
2. **„Skript ausführen"** klicken
3. Aus dem Dropdown **„deploy:plesk-server"** wählen
4. **„Ausführen"** klicken
5. Warten, bis die Ausgabe erscheint (grünes ✓ = ok)

**Alternative ohne den „Skript ausführen"-Button** (etwas mehr Klicks):
- Stattdessen erst **„npm-Installation"**, dann **„App neu starten"** klicken.

## Phase 4 — LOKAL: verifizieren

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

## Häufige Fehlerbilder

### 504 Gateway Timeout nach Deploy
**Ursache 1: SECRET fehlt oder zu kurz** (App crashed beim Start)
→ Plesk → Node.js → Umgebungsvariablen: `SECRET` muss ≥ 32 Zeichen sein.
→ App-Log prüfen: `logs/stderr.log` (Plesk-Dateimanager) — steht dort
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
| `scripts/plesk-server.sh`       | SERVER (UI)   | `npm ci --omit=dev` + `tmp/restart.txt` + Check|
| `scripts/post-deploy-verify.sh` | LOKAL/SERVER  | curl-Check der Public-URL                      |
| `scripts/deploy.sh`             | SERVER (SSH)  | Legacy: git pull + npm ci + restart (siehe Header) |
| `scripts/plesk-cleanup.sh`      | SERVER (SSH)  | Notfall: 504-Fix (sudo, braucht root)          |
