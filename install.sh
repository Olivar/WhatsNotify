#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./install.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NO_START="${INSTALL_NO_START:-false}"
[[ "$APP_DIR" == "/opt/WhatsNotify" ]] || echo "NOTICE: recommended clone path is /opt/WhatsNotify (current: $APP_DIR)"

command -v git >/dev/null || { echo "git is required"; exit 2; }
command -v node >/dev/null || { echo "Node.js >=18 is required"; exit 2; }
command -v npm >/dev/null || { echo "npm is required"; exit 2; }
major=$(node -p 'Number(process.versions.node.split(".")[0])')
(( major >= 18 )) || { echo "Node.js >=18 required"; exit 2; }

missing=()
for x in curl flock python3; do command -v "$x" >/dev/null || missing+=("$x"); done
if ((${#missing[@]})); then
  apt-get update
  apt-get install -y curl util-linux python3
fi

getent group whatsnotify >/dev/null || groupadd --system whatsnotify
id whatsnotify >/dev/null 2>&1 || useradd --system --gid whatsnotify --home-dir /var/lib/whatsnotify --shell /usr/sbin/nologin whatsnotify

install -d -o root -g whatsnotify -m 0750 /etc/whatsnotify
install -d -o whatsnotify -g whatsnotify -m 0700 \
  /var/lib/whatsnotify \
  /var/lib/whatsnotify/sessions \
  /var/lib/whatsnotify/web-cache \
  /var/lib/whatsnotify/puppeteer-cache
install -d -o root -g whatsnotify -m 0750 /var/log/whatsnotify

ENV=/etc/whatsnotify/whatsnotify.env
if [[ ! -e "$ENV" ]]; then
  cp "$APP_DIR/.env.example" "$ENV"
  sed -i "s#^APP_DIR=.*#APP_DIR=$APP_DIR#" "$ENV"
  chmod 0640 "$ENV"
  chown root:whatsnotify "$ENV"
  echo "Created $ENV - edit required values before production use"
else
  echo "Preserved existing $ENV"
fi

set -a
source "$ENV"
set +a
export PUPPETEER_CACHE_DIR="${PUPPETEER_CACHE_DIR:-/var/lib/whatsnotify/puppeteer-cache}"

cd "$APP_DIR"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
chown -R whatsnotify:whatsnotify "$PUPPETEER_CACHE_DIR"

chown -R root:whatsnotify "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
chmod +x install.sh update.sh scripts/*.sh migrate-from-legacy.sh 2>/dev/null || true

sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/index.js#$APP_DIR/index.js#" systemd/whatsnotify.service > /etc/systemd/system/whatsnotify.service
sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/update.sh#$APP_DIR/update.sh#" systemd/whatsnotify-update.service > /etc/systemd/system/whatsnotify-update.service
sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/update.sh#$APP_DIR/update.sh#" systemd/whatsnotify-update-manual.service > /etc/systemd/system/whatsnotify-update-manual.service
cp systemd/whatsnotify-update.timer /etc/systemd/system/
cp systemd/whatsnotify-update.sudoers /etc/sudoers.d/whatsnotify-update
chmod 0440 /etc/sudoers.d/whatsnotify-update

systemctl daemon-reload
systemctl enable whatsnotify.service

if [[ "$INSTALL_NO_START" == "true" ]]; then
  systemctl disable --now whatsnotify-update.timer >/dev/null 2>&1 || true
  echo "Staged installation complete; services were not started."
else
  systemctl enable --now whatsnotify-update.timer
  systemctl restart whatsnotify.service || true
  sleep 2
  systemctl --no-pager --full status whatsnotify.service || true
  systemctl --no-pager list-timers whatsnotify-update.timer || true
fi

cat <<EOF
Installation complete.
Configuration: $ENV
Service: systemctl status whatsnotify
Logs: journalctl -u whatsnotify -f
Update check: $APP_DIR/update.sh --check
Manual update: $APP_DIR/update.sh
Dashboard: http://127.0.0.1:8080/
EOF
