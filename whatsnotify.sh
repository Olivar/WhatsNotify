#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${WHATSNOTIFY_REPO_URL:-https://github.com/Olivar/WhatsNotify.git}"
APP_DIR="${APP_DIR:-/opt/WhatsNotify}"
ENV_FILE="${ENV_FILE:-/etc/whatsnotify/whatsnotify.env}"
LEGACY_DIR="${LEGACY_DIR:-/opt/whatsapp-forwarder}"
LEGACY_ENV="${LEGACY_ENV:-/etc/default/whatsapp-forwarder}"
SERVICE="whatsnotify.service"
LEGACY_SERVICE="whatsapp-forwarder.service"
STATE_FILE="${UPDATE_STATE_FILE:-/var/lib/whatsnotify/update-state.json}"
LOG_FILE="${UPDATE_LOG_FILE:-/var/log/whatsnotify/update.log}"
LOCK_FILE="${UPDATE_LOCK_FILE:-/var/lock/whatsnotify-update.lock}"
MODE="${1:-install}"
SCRIPT_REAL="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_REAL")" && pwd)"

say(){ printf '%s\n' "$*"; }
log(){ mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true; printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE"; }
die(){ log "ERROR $*"; exit 1; }
need_root(){ [[ $EUID -eq 0 ]] || die "Execute como root: sudo $0 $MODE"; }
have(){ command -v "$1" >/dev/null 2>&1; }

json_state(){
  mkdir -p "$(dirname "$STATE_FILE")"
  python3 - "$STATE_FILE" "$@" <<'PY'
import json,sys,os,tempfile
path=sys.argv[1]; pairs=sys.argv[2:]
try:
    with open(path) as f: data=json.load(f)
except Exception: data={}
for item in pairs:
    k,v=item.split('=',1)
    if v == '__NULL__': data[k]=None
    elif v in ('true','false'): data[k]=(v=='true')
    else:
        try: data[k]=int(v)
        except ValueError: data[k]=v
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix='.update-',text=True)
with os.fdopen(fd,'w') as f: json.dump(data,f,separators=(',',':'))
os.replace(tmp,path)
PY
}

load_env(){
  if [[ -r "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  STATE_FILE="${UPDATE_STATE_FILE:-$STATE_FILE}"
  LOG_FILE="${UPDATE_LOG_FILE:-$LOG_FILE}"
}

install_node_if_needed(){
  local major=0
  if have node; then major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"; fi
  (( major >= 18 )) && return 0
  log "Instalando Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( major >= 18 )) || die "Falha ao instalar Node.js >=18"
}

ensure_base_packages(){
  need_root
  if ! have apt-get; then die "Distribuição não suportada automaticamente; esperado Debian/Ubuntu com apt"; fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git curl ca-certificates util-linux python3 openssl xz-utils \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 \
    libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 xdg-utils
  install_node_if_needed
  have npm || die "npm não encontrado após instalação do Node.js"
}

ensure_checkout(){
  if [[ -d "$APP_DIR/.git" ]]; then return; fi
  if [[ "$SCRIPT_DIR" != "$APP_DIR" && -d "$SCRIPT_DIR/.git" ]]; then APP_DIR="$SCRIPT_DIR"; return; fi
  [[ ! -e "$APP_DIR" || -z "$(ls -A "$APP_DIR" 2>/dev/null)" ]] || die "$APP_DIR existe e não é checkout Git"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch main --single-branch "$REPO_URL" "$APP_DIR"
  exec "$APP_DIR/whatsnotify.sh" "$MODE"
}

ensure_user_dirs(){
  getent group whatsnotify >/dev/null || groupadd --system whatsnotify
  id whatsnotify >/dev/null 2>&1 || useradd --system --gid whatsnotify --home-dir /var/lib/whatsnotify --shell /usr/sbin/nologin whatsnotify
  install -d -o root -g whatsnotify -m 0750 /etc/whatsnotify /var/log/whatsnotify
  install -d -o whatsnotify -g whatsnotify -m 0700 \
    /var/lib/whatsnotify /var/lib/whatsnotify/sessions \
    /var/lib/whatsnotify/web-cache /var/lib/whatsnotify/puppeteer-cache
}

set_env_value(){
  local key="$1" value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); key=sys.argv[2]; value=sys.argv[3]
lines=p.read_text().splitlines() if p.exists() else []
out=[]; done=False
for line in lines:
    if line.startswith(key+'='):
        out.append(f'{key}={value}'); done=True
    else: out.append(line)
if not done: out.append(f'{key}={value}')
p.write_text('\n'.join(out)+'\n')
PY
}

create_env_if_missing(){
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    set_env_value APP_DIR "$APP_DIR"
    chown root:whatsnotify "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
}

migrate_legacy_env(){
  [[ -r "$LEGACY_ENV" ]] || return 0
  log "Migrando configuração legada: $LEGACY_ENV"
  while IFS='=' read -r key value; do
    [[ -n "$key" && "$key" != \#* ]] || continue
    case "$key" in
      SOURCE_CHAT_ID|TARGET_GROUP_ID|WHATSAPP_SESSION_ID|WWEB_VERSION|FORWARD_RETRIES|RETRY_DELAY_MS|DEDUP_TTL_MS|READY_TIMEOUT_MS|SOAP_ENABLED|SOAP_ENDPOINT|SOAP_CRON|SOAP_TIMEZONE|SOAP_TIMEOUT_MS|SOAP_RETRIES|SOAP_RETRY_DELAY_MS|SOAP_RUN_ON_START|NTP_SERVERS|NTP_INTERVAL_MS|NTP_TIMEOUT_MS|NTP_DEGRADED_OFFSET_MS|DASHBOARD_ENABLED|DASHBOARD_BIND|DASHBOARD_PORT|DASHBOARD_USER|DASHBOARD_PASSWORD|DASHBOARD_ALLOW_UPDATE|AUTO_UPDATE_ENABLED|AUTO_UPDATE_INTERVAL|AUTO_UPDATE_BRANCH|AUTO_UPDATE_REMOTE)
        value="${value%\"}"; value="${value#\"}"
        set_env_value "$key" "$value"
        ;;
    esac
  done < "$LEGACY_ENV"
}

ensure_dashboard_password(){
  load_env
  if [[ -z "${DASHBOARD_PASSWORD:-}" || "${DASHBOARD_PASSWORD:-}" == "CHANGE_ME_LONG_RANDOM_PASSWORD" ]]; then
    local generated
    generated="$(openssl rand -base64 30 | tr -d '\n')"
    set_env_value DASHBOARD_PASSWORD "$generated"
    log "Senha do dashboard gerada automaticamente"
    say "DASHBOARD_PASSWORD=$generated"
  fi
}

copy_tree(){ local src="$1" dst="$2"; [[ -d "$src" ]] || return 0; mkdir -p "$dst"; cp -a "$src"/. "$dst"/; }

stop_and_migrate_legacy_state(){
  [[ -d "$LEGACY_DIR" ]] || return 0
  log "Parando serviço legado para cópia consistente da sessão"
  systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
  if [[ -d "$LEGACY_DIR/.wwebjs_auth" ]]; then log "Migrando sessão WhatsApp"; copy_tree "$LEGACY_DIR/.wwebjs_auth" /var/lib/whatsnotify/sessions; fi
  if [[ -d "$LEGACY_DIR/.wwebjs_cache" ]]; then log "Migrando cache WhatsApp Web"; copy_tree "$LEGACY_DIR/.wwebjs_cache" /var/lib/whatsnotify/web-cache; fi
  if [[ -d "$LEGACY_DIR/.cache/puppeteer" ]]; then log "Migrando cache Puppeteer"; copy_tree "$LEGACY_DIR/.cache/puppeteer" /var/lib/whatsnotify/puppeteer-cache; fi
  chown -R whatsnotify:whatsnotify /var/lib/whatsnotify
}

install_dependencies(){
  load_env
  export PUPPETEER_CACHE_DIR="${PUPPETEER_CACHE_DIR:-/var/lib/whatsnotify/puppeteer-cache}"
  cd "$APP_DIR"
  if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
  chown -R whatsnotify:whatsnotify "$PUPPETEER_CACHE_DIR"
}

deploy_systemd(){
  cd "$APP_DIR"
  sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/index.js#$APP_DIR/index.js#" systemd/whatsnotify.service > /etc/systemd/system/whatsnotify.service
  sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/whatsnotify.sh#$APP_DIR/whatsnotify.sh#" systemd/whatsnotify-update.service > /etc/systemd/system/whatsnotify-update.service
  sed "s#WorkingDirectory=/opt/WhatsNotify#WorkingDirectory=$APP_DIR#; s#/opt/WhatsNotify/whatsnotify.sh#$APP_DIR/whatsnotify.sh#" systemd/whatsnotify-update-manual.service > /etc/systemd/system/whatsnotify-update-manual.service
  cp systemd/whatsnotify-update.timer /etc/systemd/system/
  cp systemd/whatsnotify-update.sudoers /etc/sudoers.d/whatsnotify-update
  chmod 0440 /etc/sudoers.d/whatsnotify-update
  chmod +x "$APP_DIR/whatsnotify.sh" "$APP_DIR/install.sh" "$APP_DIR/update.sh" "$APP_DIR/scripts/"*.sh
  systemctl daemon-reload
}

health_check(){
  local attempts="${UPDATE_HEALTH_ATTEMPTS:-45}" delay="${UPDATE_HEALTH_DELAY:-2}" url="${UPDATE_HEALTH_URL:-http://127.0.0.1:8080/api/health}" i
  for ((i=1;i<=attempts;i++)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep "$delay"
  done
  return 1
}

activate_new_service(){
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
  if ! health_check; then journalctl -u "$SERVICE" -n 100 --no-pager || true; return 1; fi
  systemctl enable --now whatsnotify-update.timer
  systemctl disable --now "$LEGACY_SERVICE" 2>/dev/null || true
}

install_or_migrate(){
  need_root
  ensure_base_packages
  ensure_checkout
  ensure_user_dirs
  create_env_if_missing
  local legacy=false legacy_was_active=false
  [[ -d "$LEGACY_DIR" || -f "$LEGACY_ENV" ]] && legacy=true
  if [[ "$legacy" == true ]]; then
    migrate_legacy_env
    systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null && legacy_was_active=true || true
  fi
  ensure_dashboard_password
  load_env
  [[ -n "${SOURCE_CHAT_ID:-}" ]] || die "SOURCE_CHAT_ID ausente em $ENV_FILE"
  [[ -n "${TARGET_GROUP_ID:-}" ]] || die "TARGET_GROUP_ID ausente em $ENV_FILE"

  # Tudo que pode falhar sem precisar parar o serviço antigo é preparado primeiro.
  install_dependencies
  deploy_systemd

  if [[ "$legacy" == true ]]; then stop_and_migrate_legacy_state; fi
  if ! activate_new_service; then
    log "Nova instalação falhou no health check"
    systemctl stop "$SERVICE" 2>/dev/null || true
    if [[ "$legacy_was_active" == true ]]; then
      log "Rollback operacional: reativando serviço legado"
      systemctl enable --now "$LEGACY_SERVICE" 2>/dev/null || true
    fi
    exit 20
  fi
  log "WhatsNotify instalado/migrado e validado"
  status_mode
}

acquire_update_lock(){ mkdir -p "$(dirname "$LOCK_FILE")" "$(dirname "$LOG_FILE")"; touch "$LOG_FILE"; exec 9>"$LOCK_FILE"; flock -n 9 || die "Atualização já em execução"; }

update_common(){
  need_root
  ensure_base_packages
  ensure_checkout
  load_env
  acquire_update_lock
  cd "$APP_DIR"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Working tree contém alterações rastreadas"
}

check_mode(){
  ensure_checkout
  load_env
  cd "$APP_DIR"
  local remote="${AUTO_UPDATE_REMOTE:-origin}" branch="${AUTO_UPDATE_BRANCH:-main}" current latest
  git fetch --prune "$remote" "$branch" >/dev/null
  current="$(git rev-parse HEAD)"; latest="$(git rev-parse "$remote/$branch")"
  say "Current commit: ${current:0:12}"
  say "Latest commit:  ${latest:0:12}"
  [[ "$current" == "$latest" ]] && say "Update available: no" || say "Update available: yes"
}

do_update(){
  local auto="${1:-false}"
  update_common
  local remote="${AUTO_UPDATE_REMOTE:-origin}" branch="${AUTO_UPDATE_BRANCH:-main}" interval="${AUTO_UPDATE_INTERVAL:-300}"
  if [[ "$auto" == true ]]; then
    [[ "${AUTO_UPDATE_ENABLED:-true}" == true ]] || exit 0
    local now last=0
    now="$(date +%s)"
    if [[ -f "$STATE_FILE" ]]; then last="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("lastCheckEpoch",0)))' "$STATE_FILE" 2>/dev/null || echo 0)"; fi
    (( now - last >= interval )) || exit 0
  fi

  local current latest previous
  current="$(git rev-parse HEAD)"
  log "Checking updates current=$current remote=$remote/$branch"
  json_state lastCheck="$(date -Is)" lastCheckEpoch="$(date +%s)" installedCommit="$current" lastStatus=checking lastError=__NULL__
  if ! git fetch --prune "$remote" "$branch" >>"$LOG_FILE" 2>&1; then json_state lastStatus=fetch_failed lastError="git fetch failed"; die "git fetch falhou"; fi
  latest="$(git rev-parse "$remote/$branch")"
  json_state latestCommit="$latest"
  if [[ "$current" == "$latest" ]]; then json_state lastStatus=up_to_date; log "Already up to date"; return; fi
  git merge-base --is-ancestor "$current" "$latest" || die "Remote não é fast-forward do commit instalado"
  previous="$current"
  json_state previousCommit="$previous" lastStatus=updating

  rollback_update(){
    local rc=$?
    trap - ERR
    log "Update failed rc=$rc; rollback=$previous"
    git reset --hard "$previous" >>"$LOG_FILE" 2>&1 || true
    install_dependencies >>"$LOG_FILE" 2>&1 || true
    deploy_systemd >>"$LOG_FILE" 2>&1 || true
    systemctl restart "$SERVICE" || true
    json_state lastStatus=rolled_back rollbackCommit="$previous" lastError="update failed rc=$rc"
    exit "$rc"
  }
  trap rollback_update ERR
  git reset --hard "$latest" >>"$LOG_FILE" 2>&1
  install_dependencies >>"$LOG_FILE" 2>&1
  deploy_systemd >>"$LOG_FILE" 2>&1
  [[ -x scripts/upgrade.sh ]] && scripts/upgrade.sh upgrade "$previous" "$latest" >>"$LOG_FILE" 2>&1
  systemctl restart "$SERVICE"
  health_check
  trap - ERR
  json_state lastUpdate="$(date -Is)" installedCommit="$latest" lastStatus=success lastError=__NULL__ rollbackCommit=__NULL__
  log "Update OK commit=$latest"
}

rollback_mode(){
  update_common
  local target="${2:-}"
  if [[ -z "$target" && -f "$STATE_FILE" ]]; then target="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("previousCommit", ""))' "$STATE_FILE" 2>/dev/null || true)"; fi
  [[ -n "$target" ]] || die "Commit de rollback não disponível. Use: $0 rollback <sha>"
  git cat-file -e "$target^{commit}" 2>/dev/null || die "Commit inválido: $target"
  local current="$(git rev-parse HEAD)"
  json_state previousCommit="$current" lastStatus=rolling_back
  git reset --hard "$target"
  install_dependencies
  deploy_systemd
  systemctl restart "$SERVICE"
  health_check || die "Rollback aplicado mas health check falhou"
  json_state lastStatus=rollback_success installedCommit="$target" rollbackCommit="$target" lastUpdate="$(date -Is)"
  log "Rollback OK commit=$target"
}

repair_mode(){
  need_root
  ensure_base_packages
  ensure_checkout
  ensure_user_dirs
  create_env_if_missing
  ensure_dashboard_password
  load_env
  install_dependencies
  deploy_systemd
  systemctl enable --now "$SERVICE"
  systemctl enable --now whatsnotify-update.timer
  health_check || die "Repair concluído, porém health check falhou"
  log "Repair OK"
}

status_mode(){
  say "=== WhatsNotify ==="
  if [[ -d "$APP_DIR/.git" ]]; then say "Commit: $(git -C "$APP_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"; fi
  say "Service: $(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  say "Enabled: $(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
  say "Update timer: $(systemctl is-active whatsnotify-update.timer 2>/dev/null || true)"
  if [[ -r "$ENV_FILE" ]]; then load_env; say "Dashboard: http://${DASHBOARD_BIND:-127.0.0.1}:${DASHBOARD_PORT:-8080}/"; fi
  if [[ -f "$STATE_FILE" ]]; then say "Update state: $(cat "$STATE_FILE")"; fi
  systemctl --no-pager --full status "$SERVICE" 2>/dev/null | head -20 || true
}

case "$MODE" in
  install|migrate) install_or_migrate ;;
  update) do_update false ;;
  auto|--auto) do_update true ;;
  check|--check) check_mode ;;
  rollback) rollback_mode "$@" ;;
  repair) repair_mode ;;
  status) status_mode ;;
  *)
    cat <<EOF
Usage: $0 {install|migrate|update|check|rollback [sha]|repair|status}

install   Instala dependências, clona/configura e migra automaticamente o legado.
migrate   Alias de install.
update    Atualiza origin/main com health check e rollback automático.
check     Verifica se existe nova versão.
rollback  Retorna ao previousCommit ou SHA informado.
repair    Reaplica dependências, permissões, systemd e health check.
status    Exibe estado resumido.
EOF
    exit 2
    ;;
esac
