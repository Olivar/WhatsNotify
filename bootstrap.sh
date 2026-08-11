#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${WHATSNOTIFY_REPO_URL:-https://github.com/Olivar/WhatsNotify.git}"
APP_DIR="${APP_DIR:-/opt/WhatsNotify}"
MODE="${1:-install}"

if [[ $EUID -ne 0 ]]; then
  echo "Execute como root: sudo bash bootstrap.sh $MODE" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || { echo "git ausente e apt-get não disponível" >&2; exit 2; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git ca-certificates
fi

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --prune origin main
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only origin main
else
  if [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    echo "ERRO: $APP_DIR existe e não é um checkout Git." >&2
    exit 3
  fi
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch main --single-branch "$REPO_URL" "$APP_DIR"
fi

exec /usr/bin/env bash "$APP_DIR/whatsnotify.sh" "$MODE"
