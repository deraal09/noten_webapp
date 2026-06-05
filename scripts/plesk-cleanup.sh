#!/usr/bin/env bash
#
# scripts/plesk-cleanup.sh
#
# Entfernt Überreste vom alten Python/Passenger-Setup und regeneriert den
# Plesk-vhost, damit Plesks Node.js-Handler korrekt greift (504-Fix).
#
# Idempotent: kann jederzeit gefahrlos erneut ausgeführt werden.
# Voraussetzung: Plesk-Web-Admin, Subdomain bereits mit Node.js-Anwendung
# verknüpft (Anwendungs-Wurzel + Startdatei app.js gesetzt).
#
# Aufruf auf dem Server:
#   bash scripts/plesk-cleanup.sh
#
# Optionaler Parameter: Subdomain (Default: noten.bbz-rd-eck.com)
#   bash scripts/plesk-cleanup.sh noten.bbz-rd-eck.com

set -euo pipefail

SUBDOMAIN="${1:-noten.bbz-rd-eck.com}"
APP_ROOT="/var/www/vhosts/bbz-rd-eck.com/${SUBDOMAIN}"
APP_PORT="${APP_PORT:-3001}"  # Default-Port, den Plesk dieser App üblicherweise zuweist
PUBLIC_URL="https://${SUBDOMAIN}"

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
info()   { printf '\033[0;36m[INFO]\033[0m %s\n' "$*"; }

echo
info "Plesk-Cleanup für ${SUBDOMAIN}"
info "App-Wurzel: ${APP_ROOT}"
echo

# --- 0. Vorbedingungen prüfen ------------------------------------------------

if [[ ! -d "${APP_ROOT}" ]]; then
  red "FEHLER: ${APP_ROOT} existiert nicht. Subdomain prüfen."
  exit 1
fi

if ! command -v plesk >/dev/null 2>&1; then
  red "FEHLER: 'plesk' nicht im PATH. Skript muss auf dem Plesk-Server laufen."
  exit 1
fi

# --- 1. Alte Python/Passenger-Überreste entfernen ----------------------------

info "1/4 — Entferne alte Python/Passenger-Überreste …"
cd "${APP_ROOT}"
REMOVED=0
for f in passenger_wsgi.py wsgi.py .htaccess; do
  if [[ -f "${f}" ]]; then
    sudo rm -f "${f}"
    info "  gelöscht: ${f}"
    REMOVED=$((REMOVED + 1))
  fi
done
for d in __pycache__ instance venv; do
  if [[ -d "${d}" ]]; then
    sudo rm -rf "${d}"
    info "  gelöscht: ${d}/"
    REMOVED=$((REMOVED + 1))
  fi
done
if [[ ${REMOVED} -eq 0 ]]; then
  info "  nichts zu tun (sauber)"
fi

# --- 2. Plesk-vhost neu generieren -------------------------------------------

info "2/4 — Regeneriere Plesk-vhost …"
sudo plesk repair web "${SUBDOMAIN}"

# --- 3. Node.js-Anwendung neu starten ----------------------------------------

info "3/4 — Starte Node.js-Anwendung neu …"
sudo plesk ext nodejs --restart "${SUBDOMAIN}" 2>/dev/null \
  || yellow "  Hinweis: 'plesk ext nodejs --restart' fehlgeschlagen — manuell via Plesk-UI neu starten."

# --- 4. Erreichbarkeit verifizieren -----------------------------------------

info "4/4 — Verifiziere Erreichbarkeit (bis zu 15 s warten) …"
APP_OK=false
PUB_OK=false

for i in $(seq 1 15); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${APP_PORT}/login" 2>/dev/null \
     || curl -sS -o /dev/null --max-time 3 -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/login" 2>/dev/null | grep -qE '^(2|3)'; then
    APP_OK=true
    break
  fi
  sleep 1
done

if [[ "${APP_OK}" == "true" ]]; then
  green "  ✓ App antwortet intern auf Port ${APP_PORT}"
else
  yellow "  ⚠ App antwortet (noch) nicht intern auf Port ${APP_PORT} — ggf. Node.js-Anwendung ist noch nicht hochgefahren. Log prüfen."
fi

if curl -fsSL -o /dev/null --max-time 10 "${PUBLIC_URL}/login" 2>/dev/null \
   || curl -sSL -o /dev/null --max-time 10 -w '%{http_code}' "${PUBLIC_URL}/login" 2>/dev/null | grep -qE '^(2|3)'; then
  PUB_OK=true
fi

if [[ "${PUB_OK}" == "true" ]]; then
  green "  ✓ Öffentlich erreichbar: ${PUBLIC_URL}/login"
else
  yellow "  ⚠ Öffentlich (noch) nicht erreichbar: ${PUBLIC_URL}/login"
  yellow "     Falls 504 weiterhin auftritt:"
  yellow "       - Inhalt von ${APP_ROOT}/logs/stderr.log (oder tmp/stderr.log) prüfen"
  yellow "       - Plesk-UI: Node.js → 'Anwendung neu starten' klicken"
  yellow "       - ENV-Variablen in Plesk-UI prüfen: SECRET, NODE_ENV=production, PUBLIC_URL"
fi

echo
green "Fertig."
