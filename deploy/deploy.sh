#!/usr/bin/env bash
# Deploy vedit (the Telegram bot) from the dev laptop to the server. Run in Git Bash from the repo root:
#
#   bash deploy/deploy.sh [IP] [--setup] [--setup-args "--with-python-asr"] [--ref <commit>] [--no-env] [--strict]
#   bash deploy/deploy.sh [IP] --log            # deploy history on the server
#
#   IP           server address; default: the contents of ~/.oci/vedit-ip.txt
#   --setup      run deploy/setup-ubuntu.sh on the server first (automatic when the server is not prepared yet)
#   --ref X      deploy commit X instead of HEAD (rollback: --ref <earlier sha>, see --log)
#   --no-env     do not upload .env (keep the server's)
#   --strict     do not restart the bot when `vedit doctor` finds something required missing
#
# What it does: git bundle of the commit (incremental when the server already has an ancestor) → scp →
# on the server (deploy/remote-update.sh, as root): checkout in /opt/vedit/app as user vedit, `npm ci --omit=dev`
# when package-lock.json changed, whisper.cpp / Piper when missing, .env (chmod 600, owner vedit; machine-specific
# keys from the laptop's .env are dropped), `vedit doctor --bot`, `systemctl restart vedit-bot`, last 30 log lines.
# Only committed code is deployed — uncommitted changes stay on the laptop (a warning says so).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
KEY="${VEDIT_SSH_KEY:-$HOME/.ssh/vedit_oracle}"
USER_AT="${VEDIT_SSH_USER:-ubuntu}"
HOST=""
REF=HEAD
SETUP=0
SETUP_ARGS=""
SEND_ENV=1
STRICT=""
SHOW_LOG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup) SETUP=1 ;;
    --setup-args) SETUP_ARGS="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --no-env) SEND_ENV=0 ;;
    --strict) STRICT=--strict ;;
    --log) SHOW_LOG=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) HOST="$1" ;;
  esac
  shift
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -z "$HOST" ]]; then
  [[ -f "$HOME/.oci/vedit-ip.txt" ]] || die "укажите IP: bash deploy/deploy.sh <IP> (или запишите его в ~/.oci/vedit-ip.txt)"
  HOST="$(tr -d ' \r\n' < "$HOME/.oci/vedit-ip.txt")"
fi
[[ -f "$KEY" ]] || die "нет SSH-ключа $KEY (VEDIT_SSH_KEY=… чтобы указать другой)"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=20 -o BatchMode=yes)
ssh_run() { ssh "${SSH_OPTS[@]}" "$USER_AT@$HOST" "$@"; }
scp_to() { scp -q "${SSH_OPTS[@]}" "$@"; }

step "сервер $USER_AT@$HOST"
ssh_run 'echo "  $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m), $(nproc) CPU, $(free -g | awk "/Mem:/ {print \$2}") ГБ RAM"' || die "нет SSH-доступа к $HOST"

if (( SHOW_LOG )); then
  ssh_run 'tail -n 30 /opt/vedit/deploys.log 2>/dev/null || echo "деплоев ещё не было"'
  exit 0
fi

COMMIT="$(git rev-parse --verify "${REF}^{commit}")" || die "нет коммита $REF"
step "коммит $(git log -1 --format='%h %s' "$COMMIT" | cut -c1-90)"
if [[ "$REF" == HEAD ]] && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "есть незакоммиченные изменения — они НЕ попадут на сервер (деплоится только коммит $(git rev-parse --short HEAD))"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; git update-ref -d refs/vedit/deploy 2>/dev/null || true' EXIT
REMOTE_TMP="$(ssh_run 'mktemp -d /tmp/vedit-deploy-XXXXXX')"

# ── server preparation (first time, or --setup) ──
if (( SETUP )) || ! ssh_run 'test -f /opt/vedit/server.env'; then
  step "подготовка сервера: deploy/setup-ubuntu.sh ${SETUP_ARGS} (несколько минут)"
  scp_to deploy/setup-ubuntu.sh "$USER_AT@$HOST:$REMOTE_TMP/setup-ubuntu.sh"
  # shellcheck disable=SC2086 # SETUP_ARGS is a list of flags
  ssh_run "sudo bash $REMOTE_TMP/setup-ubuntu.sh $SETUP_ARGS"
fi

# ── code: a bundle with only what the server lacks ──
step "код"
REMOTE_HEAD="$(ssh_run 'sudo -u vedit git -C /opt/vedit/app rev-parse -q --verify HEAD 2>/dev/null || true' | tr -d '\r')"
BUNDLE_ARG=""
if ssh_run "sudo -u vedit git -C /opt/vedit/app cat-file -e ${COMMIT}^{commit} 2>/dev/null"; then
  ok "коммит уже есть на сервере — бандл не нужен"
else
  git update-ref refs/vedit/deploy "$COMMIT"
  if [[ -n "$REMOTE_HEAD" ]] && git cat-file -e "${REMOTE_HEAD}^{commit}" 2>/dev/null && git merge-base --is-ancestor "$REMOTE_HEAD" "$COMMIT"; then
    git bundle create -q "$TMP/vedit.bundle" "${REMOTE_HEAD}..refs/vedit/deploy"
    ok "инкрементальный бандл ${REMOTE_HEAD:0:8}..${COMMIT:0:8}: $(du -h "$TMP/vedit.bundle" | cut -f1)"
  else
    git bundle create -q "$TMP/vedit.bundle" refs/vedit/deploy
    ok "полный бандл: $(du -h "$TMP/vedit.bundle" | cut -f1)"
  fi
  scp_to "$TMP/vedit.bundle" "$USER_AT@$HOST:$REMOTE_TMP/vedit.bundle"
  BUNDLE_ARG="--bundle $REMOTE_TMP/vedit.bundle"
fi

# ── .env: the laptop's keys, without machine-specific paths and logins ──
ENV_ARG=""
if (( SEND_ENV )) && [[ -f .env ]]; then
  step ".env"
  # these are set by /opt/vedit/server.env or make no sense on the server (Windows paths, local logins)
  DROP='^[[:space:]]*(export[[:space:]]+)?(VEDIT_SERVER|VEDIT_WORKSPACE|VEDIT_VOICE_DIR|VEDIT_WHISPER_BIN|VEDIT_WHISPER_MODEL|WHISPER_BIN|WHISPER_MODEL|VEDIT_CHROME|HYPERFRAMES_BROWSER_PATH|PRODUCER_HEADLESS_SHELL_PATH|PUPPETEER_EXECUTABLE_PATH|CHROME_PATH|FFMPEG_PATH|FFPROBE_PATH|VEDIT_AGY_BIN|VEDIT_ASR_PYTHON|VEDIT_PROMPTS_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)='
  (umask 077; tr -d '\r' < .env | grep -vE "$DROP" > "$TMP/vedit.env" || true)
  DROPPED="$(tr -d '\r' < .env | grep -oE "$DROP" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' | sort -u | tr '\n' ' ' || true)"
  [[ -n "$DROPPED" ]] && ok "не переносятся (машинные): $DROPPED"
  for k in TELEGRAM_BOT_TOKEN GEMINI_API_KEY TELEGRAM_ADMIN_IDS; do
    grep -qE "^[[:space:]]*(export[[:space:]]+)?${k}=." "$TMP/vedit.env" && ok "$k есть" || warn "$k нет в .env"
  done
  # Claude is optional since stage 29: without it every LLM step runs on Gemini
  grep -qE "^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=." "$TMP/vedit.env" && ok "ANTHROPIC_API_KEY есть (Claude, запаска — Gemini)" || ok "ANTHROPIC_API_KEY нет — планы и сценарии на Gemini"
  scp_to "$TMP/vedit.env" "$USER_AT@$HOST:$REMOTE_TMP/vedit.env"
  ENV_ARG="--env $REMOTE_TMP/vedit.env"
elif (( SEND_ENV )); then
  warn "локального .env нет — на сервере остаётся прежний"
fi

# ── on the server ──
scp_to deploy/remote-update.sh "$USER_AT@$HOST:$REMOTE_TMP/remote-update.sh"
step "на сервере"
set +e
# shellcheck disable=SC2086 # the *_ARG strings are "--flag value" pairs without spaces in values
ssh_run "sudo bash $REMOTE_TMP/remote-update.sh --commit $COMMIT $BUNDLE_ARG $ENV_ARG $STRICT; rc=\$?; sudo rm -rf $REMOTE_TMP; exit \$rc"
RC=$?
set -e
if (( RC == 0 )); then
  step "готово: ${COMMIT:0:12} на $HOST"
  echo "  логи:   ssh -i $KEY $USER_AT@$HOST 'journalctl -u vedit-bot -f'"
  echo "  откат:  bash deploy/deploy.sh $HOST --ref <sha>   (история: bash deploy/deploy.sh $HOST --log)"
else
  die "деплой не завершён (код $RC) — см. вывод выше"
fi
