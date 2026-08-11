#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/WhatsNotify}"
TARGET="${1:?rollback commit required}"
cd "$APP_DIR"
git reset --hard "$TARGET"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
[[ -x scripts/upgrade.sh ]] && scripts/upgrade.sh rollback "$TARGET" || true
systemctl restart whatsnotify
