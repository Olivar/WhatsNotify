#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/WhatsNotify}"
ENV_FILE="${ENV_FILE:-/etc/whatsnotify/whatsnotify.env}"
STATE_FILE="${UPDATE_STATE_FILE:-/var/lib/whatsnotify/update-state.json}"
LOG_FILE="${UPDATE_LOG_FILE:-/var/log/whatsnotify/update.log}"
LOCK_FILE="${UPDATE_LOCK_FILE:-/var/lock/whatsnotify-update.lock}"
MODE="${1:-update}"

if [[ -r "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi
BRANCH="${AUTO_UPDATE_BRANCH:-main}"
REMOTE="${AUTO_UPDATE_REMOTE:-origin}"
INTERVAL="${AUTO_UPDATE_INTERVAL:-300}"
AUTO="${AUTO_UPDATE_ENABLED:-true}"

mkdir -p "$(dirname "$STATE_FILE")" "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then echo "Update already running"; exit 75; fi

log(){ printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE"; }
json_state(){
  python3 - "$STATE_FILE" "$@" <<'PY'
import json,sys,os,tempfile
path=sys.argv[1]; pairs=sys.argv[2:]
try:
    with open(path) as f: data=json.load(f)
except Exception: data={}
for item in pairs:
    k,v=item.split('=',1); data[k]=None if v=='__NULL__' else v
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix='.update-',text=True)
with os.fdopen(fd,'w') as f: json.dump(data,f,separators=(',',':'))
os.replace(tmp,path)
PY
}

cd "$APP_DIR"
if [[ ! -d .git ]]; then log "ERROR not a git checkout: $APP_DIR"; exit 2; fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "ERROR tracked working tree is dirty"
  json_state lastStatus=blocked lastError="tracked working tree dirty"
  exit 3
fi

if [[ "$MODE" == "--auto" ]]; then
  [[ "$AUTO" == "true" ]] || exit 0
  now=$(date +%s); last=0
  if [[ -f "$STATE_FILE" ]]; then
    last=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(int(d.get("lastCheckEpoch",0)))' "$STATE_FILE" 2>/dev/null || echo 0)
  fi
  (( now - last >= INTERVAL )) || exit 0
fi

CURRENT=$(git rev-parse HEAD)
log "Checking for updates current=$CURRENT remote=$REMOTE/$BRANCH"
json_state lastCheck="$(date -Is)" lastCheckEpoch="$(date +%s)" installedCommit="$CURRENT" lastStatus=checking lastError=__NULL__

if ! git fetch --prune "$REMOTE" "$BRANCH" >>"$LOG_FILE" 2>&1; then
  log "ERROR git fetch failed"
  json_state lastStatus=fetch_failed lastError="git fetch failed"
  exit 4
fi
REMOTE_SHA=$(git rev-parse "$REMOTE/$BRANCH")
json_state latestCommit="$REMOTE_SHA"

if [[ "$MODE" == "--check" ]]; then
  echo "Current commit: ${CURRENT:0:7}"
  echo "Latest commit: ${REMOTE_SHA:0:7}"
  [[ "$CURRENT" == "$REMOTE_SHA" ]] && echo "Update available: no" || echo "Update available: yes"
  json_state lastStatus=checked
  exit 0
fi

if [[ "$CURRENT" == "$REMOTE_SHA" ]]; then log "Already up to date"; json_state lastStatus=up_to_date; exit 0; fi
if ! git merge-base --is-ancestor "$CURRENT" "$REMOTE_SHA"; then
  log "ERROR remote is not a fast-forward descendant of installed commit"
  json_state lastStatus=blocked lastError="non fast-forward main"
  exit 5
fi

PREVIOUS="$CURRENT"
log "New version detected previous=$PREVIOUS new=$REMOTE_SHA"
json_state previousCommit="$PREVIOUS" lastStatus=updating

rollback(){
  rc=$?
  trap - ERR
  log "Update failed rc=$rc; rolling back to $PREVIOUS"
  git reset --hard "$PREVIOUS" >>"$LOG_FILE" 2>&1 || true
  if [[ -f package-lock.json ]]; then npm ci --omit=dev >>"$LOG_FILE" 2>&1 || true; else npm install --omit=dev >>"$LOG_FILE" 2>&1 || true; fi
  systemctl restart whatsnotify || true
  json_state lastStatus=rolled_back rollbackCommit="$PREVIOUS" lastError="update failed rc=$rc"
  exit "$rc"
}
trap rollback ERR

git reset --hard "$REMOTE_SHA" >>"$LOG_FILE" 2>&1
log "Code updated"
if [[ -f package-lock.json ]]; then npm ci --omit=dev >>"$LOG_FILE" 2>&1; else npm install --omit=dev >>"$LOG_FILE" 2>&1; fi
log "Dependencies updated"
if [[ -x scripts/upgrade.sh ]]; then scripts/upgrade.sh upgrade "$PREVIOUS" "$REMOTE_SHA" >>"$LOG_FILE" 2>&1; fi
log "Upgrade hook completed"
systemctl restart whatsnotify
log "Service restarted"
"$APP_DIR/scripts/health-check.sh"
log "Health check OK"
trap - ERR
json_state lastUpdate="$(date -Is)" installedCommit="$REMOTE_SHA" lastStatus=success lastError=__NULL__ rollbackCommit=__NULL__
log "Update completed successfully commit=$REMOTE_SHA"
