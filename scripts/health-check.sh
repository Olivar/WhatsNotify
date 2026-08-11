#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${ENV_FILE:-/etc/whatsnotify/whatsnotify.env}"
if [[ -r "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi
URL="${UPDATE_HEALTH_URL:-http://127.0.0.1:8080/api/health}"
ATTEMPTS="${UPDATE_HEALTH_ATTEMPTS:-30}"
DELAY="${UPDATE_HEALTH_DELAY:-2}"
for ((i=1;i<=ATTEMPTS;i++)); do
  if curl -fsS --max-time 3 "$URL" | grep -q '"status":"ok"'; then exit 0; fi
  sleep "$DELAY"
done
exit 1
