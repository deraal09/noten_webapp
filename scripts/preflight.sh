#!/usr/bin/env bash
#
# scripts/preflight.sh
#
# Lokaler Pre-Deploy-Check. Auf der Entwicklermaschine ausführen, BEVOR
# `git push origin devel` läuft. Stellt sicher, dass der Stand, der gleich
# auf den Server gepusht wird, getestet ist und auf dem richtigen Branch
# sitzt. Die eigentliche Auslieferung läuft danach über die Plesk-UI
# (siehe docs/DEPLOY.md).
#
# Aufruf:
#   npm run deploy:preflight
#
# Exit-Codes:
#   0  alles ok, push kann losgehen
#   1  Tests fehlgeschlagen oder schwerwiegender Fehler

set -euo pipefail

cd "$(dirname "$0")/.."

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
info()   { printf '\033[0;36m[preflight]\033[0m %s\n' "$*"; }

# --- 1. Working-Tree-Status ------------------------------------------------

echo
info "1/4 — Working-Tree-Status …"

UNCOMMITTED=0
if ! git diff --quiet 2>/dev/null; then UNCOMMITTED=1; fi
if ! git diff --cached --quiet 2>/dev/null; then UNCOMMITTED=1; fi
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l)

if [[ "${UNCOMMITTED}" -eq 1 || "${UNTRACKED}" -gt 0 ]]; then
  yellow "Es gibt uncommittete / nicht-getrackte Änderungen — die werden NICHT mitgepusht:"
  git status --short
  echo
else
  green "  ✓ Working tree clean"
fi

# --- 2. Branch prüfen ------------------------------------------------------

info "2/4 — Branch …"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "${BRANCH}" == "devel" ]]; then
  green "  ✓ Branch: ${BRANCH} (Plesk-Auto-Deploy erwartet diesen Branch)"
else
  yellow "  ⚠ Branch: ${BRANCH} — Plesk pullt nur 'devel'!"
  yellow "    git switch devel    (oder  git push origin ${BRANCH}  manuell in Plesk ziehen)"
  echo
fi

# --- 3. Tests laufen lassen -----------------------------------------------

info "3/4 — npm test …"
LOG=$(mktemp)
if npm test >"${LOG}" 2>&1; then
  tail -10 "${LOG}"
  green "  ✓ Tests ok"
  rm -f "${LOG}"
else
  red "  ✗ Tests fehlgeschlagen — push abbrechen."
  echo
  echo "--- Letzte 30 Zeilen Test-Log: ---"
  tail -30 "${LOG}"
  echo "---"
  echo "Voller Log: ${LOG}"
  exit 1
fi

# --- 4. Remotes prüfen -----------------------------------------------------

info "4/4 — Remote-Konfiguration …"
if git remote get-url origin >/dev/null 2>&1; then
  ORIGIN=$(git remote get-url origin)
  green "  ✓ origin: ${ORIGIN}"
else
  yellow "  ⚠ Kein 'origin'-Remote konfiguriert. Push schlägt fehl, bis gesetzt:"
  yellow "    git remote add origin git@github.com:deraal09/noten_webapp.git"
  echo
fi

# --- Nächste Schritte -----------------------------------------------------

echo
green "Preflight ok. Nächste Schritte:"
echo
echo "  1. git push origin ${BRANCH}"
echo "  2. Plesk → Git UI → 'Jetzt Pull ausführen'"
echo "     (oder warten, falls Auto-Deploy auf 'devel' aktiv ist)"
echo "  3. Plesk → Node.js UI → 'Skript ausführen' → 'deploy:plesk-server'"
echo "  4. npm run deploy:verify     # Health-Check, optional"
echo
