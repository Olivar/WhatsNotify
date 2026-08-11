#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  --auto) exec "$SCRIPT_DIR/whatsnotify.sh" auto ;;
  --check) exec "$SCRIPT_DIR/whatsnotify.sh" check ;;
  '') exec "$SCRIPT_DIR/whatsnotify.sh" update ;;
  *) exec "$SCRIPT_DIR/whatsnotify.sh" "$@" ;;
esac
