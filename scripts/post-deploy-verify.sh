#!/usr/bin/env bash
#
# scripts/post-deploy-verify.sh
#
# Health-Check nach dem Deploy. LOKAL oder auf dem SERVER ausführbar.
# Prüft primär die öffentliche URL, optional auch den internen App-Port.
#
# Aufruf:
#   npm run deploy:verify
#   PUBLIC_URL=https://staging.example.com npm run deploy:verify
#   APP_PORT=3002 npm run deploy:verify           # interner Port (Default 3001)
#   SKIP_INTERNAL=1 npm run deploy:verify         # nur öffentlich prüfen
#
# Exit-Codes:
#   0  ok
#   1  öffentliche URL antwortet nicht oder 5xx

set -euo pipefail

cd "$(dirname "$0")/.."

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
info()   { printf '\033[0;36m[verify]\033[0m %s\n' "$*"; }

PUBLIC_URL="${PUBLIC_URL:-https://noten.bbz-rd-eck.com}"
APP_PORT="${APP_PORT:-3001}"
SKIP_INTERNAL="${SKIP_INTERNAL:-0}"

# --- 1. Öffentliche URL: /login ------------------------------------------

echo
info "1/3 — ${PUBLIC_URL}/login …"
HTTP_CODE=$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 10 "${PUBLIC_URL}/login" 2>/dev/null || echo "000")
case "${HTTP_CODE}" in
  2*|3*) green "  ✓ /login → HTTP ${HTTP_CODE}" ;;
  504)   red "  ✗ 504 Gateway Timeout"
        red "    App vermutlich nicht (richtig) gestartet. Mögliche Ursachen:"
        red "      - SECRET fehlt oder < 32 Zeichen (App-Log prüfen)"
        red "      - npm ci fehlgeschlagen (in Plesk-Node-UI Log sichten)"
        red "    Plesk → Node.js → 'App neu starten' und logs/stderr.log lesen."
        exit 1 ;;
  502)   red "  ✗ 502 Bad Gateway — Proxy erreicht App nicht."
        red "    Falls Erst-Deploy: scripts/plesk-cleanup.sh auf dem Server (per SSH) laufen lassen."
        exit 1 ;;
  000)   red "  ✗ Verbindung fehlgeschlagen — Server/DNS nicht erreichbar."
        exit 1 ;;
  *)     red "  ✗ Unerwarteter HTTP-Code: ${HTTP_CODE}"
        exit 1 ;;
esac

# --- 2. /setup (DB-Initialisierungs-Status) ------------------------------

info "2/3 — ${PUBLIC_URL}/setup …"
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${PUBLIC_URL}/setup" 2>/dev/null || echo "000")
case "${HTTP_CODE}" in
  2*|3*) green "  ✓ /setup → HTTP ${HTTP_CODE}" ;;
  5*)    red "  ✗ /setup → HTTP ${HTTP_CODE} — App-Log prüfen."; exit 1 ;;
  *)     yellow "    /setup → HTTP ${HTTP_CODE} (ungewöhnlich, aber nicht kritisch)" ;;
esac

# --- 3. Optional: interner Health-Check ---------------------------------

if [[ "${SKIP_INTERNAL}" -eq 1 ]]; then
  info "3/3 — interner Check übersprungen (SKIP_INTERNAL=1)"
else
  info "3/3 — interner Check 127.0.0.1:${APP_PORT}/login …"
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${APP_PORT}/login" 2>/dev/null || echo "000")
  case "${HTTP_CODE}" in
    2*|3*) green "  ✓ 127.0.0.1:${APP_PORT}/login → HTTP ${HTTP_CODE}" ;;
    000)   yellow "    ⚠ 127.0.0.1:${APP_PORT} nicht erreichbar — normal, falls Plesk Unix-Socket verwendet."
           yellow "      (App ist trotzdem ok, wenn Phase 1/2 grün waren.)" ;;
    *)     yellow "    127.0.0.1:${APP_PORT} → HTTP ${HTTP_CODE}" ;;
  esac
fi

# --- Fertig -----------------------------------------------------------------

echo
green "Deploy-Verifizierung ok. Stand: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
