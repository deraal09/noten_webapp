#!/usr/bin/env bash
#
# scripts/plesk-server.sh
#
# Server-seitiger Deploy-Schritt für die Plesk-Web-Admin-Edition:
#   1. npm ci --omit=dev   (Dependencies reproduzierbar installieren)
#   2. tmp/restart.txt     (Phusion-Passenger-Restart auslösen)
#   3. optional Health-Check intern
#
# Aufruf: über die Plesk-UI → "Skript ausführen" → deploy:plesk-server
# (siehe package.json). NICHT direkt auf der Shell aufrufen, wenn kein
# App-Root gesetzt ist.
#
# Voraussetzungen:
#   - Plesk → Git UI hat den aktuellen Stand bereits gepullt
#   - Plesk → Node.js UI hat Anwendungs-Wurzel + app.js als Startdatei
#   - in Plesk-UI sind NODE_ENV=production, SECRET, PUBLIC_URL gesetzt
#
# Idempotent: kann gefahrlos erneut aufgerufen werden.
#
# Exit-Codes:
#   0  ok (auch wenn interner Health-Check nicht geantwortet hat)
#   1  npm ci fehlgeschlagen oder package.json fehlt

set -euo pipefail

cd "$(dirname "$0")/.."

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
info()   { printf '\033[0;36m[plesk-server]\033[0m %s\n' "$*"; }

APP_DIR="$(pwd)"

# --- 0. Vorbedingungen prüfen ---------------------------------------------

if [[ ! -f "package.json" ]]; then
  red "FEHLER: package.json nicht in ${APP_DIR} gefunden."
  red "  Plesk-Git-UI → 'Jetzt Pull ausführen' zuerst."
  exit 1
fi
if [[ ! -f "package-lock.json" ]]; then
  yellow "  ⚠ package-lock.json fehlt — fallback auf npm install (nicht reproduzierbar)."
  YELLOW_LOCK=1
fi

# --- 1. Dependencies installieren -----------------------------------------

echo
info "1/3 — Dependencies installieren …"
if [[ "${YELLOW_LOCK:-0}" -eq 1 ]]; then
  if ! npm install --omit=dev 2>&1 | tail -15; then
    red "  ✗ npm install fehlgeschlagen — App-Log prüfen."
    exit 1
  fi
else
  if ! npm ci --omit=dev 2>&1 | tail -15; then
    red "  ✗ npm ci fehlgeschlagen — App-Log prüfen."
    exit 1
  fi
fi
green "  ✓ Dependencies installiert"

# --- 2. Passenger-Restart auslösen ---------------------------------------

echo
info "2/3 — Passenger-Neustart auslösen …"
mkdir -p tmp
touch tmp/restart.txt
green "  ✓ tmp/restart.txt berührt — App startet bei der nächsten Anfrage neu"

# --- 3. Optional: kurzer interner Health-Check ----------------------------

echo
info "3/3 — Interner Health-Check (max. 10 s) …"
APP_PORT="${APP_PORT:-3001}"
APP_OK=false
for i in $(seq 1 10); do
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${APP_PORT}/login" 2>/dev/null || echo "000")
  case "${HTTP_CODE}" in
    2*|3*) green "  ✓ App antwortet intern auf Port ${APP_PORT} (HTTP ${HTTP_CODE})"; APP_OK=true; break ;;
    000)   sleep 1 ;;
    *)     yellow "    HTTP ${HTTP_CODE} (Versuch ${i}/10)"; sleep 1 ;;
  esac
done
if [[ "${APP_OK}" != "true" ]]; then
  yellow "  ⚠ App antwortet (noch) nicht intern auf Port ${APP_PORT}."
  yellow "     Normal, falls Plesk einen Unix-Socket statt TCP-Port verwendet."
  yellow "     Externe URL prüfen: https://noten.bbz-rd-eck.com/login"
fi

# --- Fertig ---------------------------------------------------------------

echo
green "Fertig. Empfohlene Verifizierung: npm run deploy:verify"
