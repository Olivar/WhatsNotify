#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${ENV_FILE:-/etc/whatsnotify/whatsnotify.env}"
if [[ -r "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi
curl -fsS -u "${DASHBOARD_USER:?}:${DASHBOARD_PASSWORD:?}" "http://${DASHBOARD_BIND:-127.0.0.1}:${DASHBOARD_PORT:-8080}/api/status"
