#!/usr/bin/env bash
#
# scripts/deploy.sh
#
# Regulärer Update-Deploy auf dem Plesk-Server per Git-Pull.
# Idempotent: holt den aktuellen Stand, installiert (nur) bei geänderten
# Dependencies neu und stößt einen Passenger-Neustart an, indem
# tmp/restart.txt berührt wird. KEIN Plesk-UI-Klick nötig.
#
# Aufruf im Application-Root der Subdomain:
#   bash scripts/deploy.sh            # oder:  npm run deploy
#
# Für den EINMALIGEN Erst-Deploy / 504-Aufräumarbeiten siehe stattdessen
# scripts/plesk-cleanup.sh (npm run deploy:plesk).

set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

info()  { printf '\033[0;36m[deploy]\033[0m %s\n' "$*"; }

info "Branch: ${BRANCH}"

# 1. Aktuellen Stand holen
info "git pull …"
git pull --ff-only origin "${BRANCH}"

# 2. Dependencies nur bei Bedarf neu installieren.
#    'npm ci' ist reproduzierbar (nutzt package-lock.json) und schneller als
#    'npm install'. --omit=dev lässt Test-/Dev-Pakete weg.
if git diff --name-only ORIG_HEAD HEAD 2>/dev/null | grep -qE '^(package\.json|package-lock\.json)$'; then
  info "Dependencies geändert → npm ci --omit=dev"
  npm ci --omit=dev
else
  info "Keine Dependency-Änderungen → npm-Install übersprungen"
fi

# 3. Passenger-Neustart auslösen (Plesk-Node = Phusion Passenger).
#    Passenger startet die App neu, sobald sich tmp/restart.txt ändert.
info "tmp/restart.txt berühren → App-Neustart"
mkdir -p tmp
touch tmp/restart.txt

info "Fertig. Die App wird beim nächsten Request neu gestartet."
