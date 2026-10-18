#!/usr/bin/env bash
# vedit: a local Telegram Bot API server (github.com/tdlib/telegram-bot-api) next to the bot — files up to 2000 MB
# instead of the cloud's 20 MB download / 50 MB upload. Runs on the server (Ubuntu 24.04 ARM64), as root:
#
#   sudo TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef bash telegram-bot-api.sh [--switch] [--rebuild] [-j N]
#
# api_id / api_hash: the bot OWNER creates them once at https://my.telegram.org → "API development tools"
# (any app title; they belong to a Telegram account, not to the bot — keep them secret).
#
# What it does (idempotent):
#   1. build deps (cmake, g++, gperf, zlib, openssl) and the server itself, from source, into /usr/local/bin
#      (1 OCPU: 30–60 min; -j 1 by default — tdlib needs ~3 GB RAM per compiler job, the swapfile helps)
#   2. /opt/vedit/tg-bot-api/{,tmp} owned by vedit, /opt/vedit/tg-bot-api.env (600) with the id/hash
#   3. telegram-bot-api.service: User=vedit, --local (getFile returns a path on this disk, the bot copies the file),
#      HTTP only on 127.0.0.1:8081
#   4. telegram-bot-api-cleanup.timer: files the server downloaded are deleted after 2 days (the bot keeps its copy)
#   5. a drop-in for vedit-bot.service: starts after the server, reads /opt/vedit/bot-api.env
#   --switch: moves the bot from the cloud to this server — logOut on api.telegram.org (once; the cloud refuses the
#      bot for ~10 minutes after that), TELEGRAM_API_BASE=http://127.0.0.1:8081 into /opt/vedit/bot-api.env, restart.
# Back to the cloud: curl -s http://127.0.0.1:8081/bot<TOKEN>/logOut; rm /opt/vedit/bot-api.env; systemctl restart vedit-bot
set -euo pipefail

VEDIT_HOME=/opt/vedit
DATA="$VEDIT_HOME/tg-bot-api"
PORT="${TELEGRAM_API_PORT:-8081}"
SWITCH=0
REBUILD=0
JOBS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --switch) SWITCH=1 ;;
    --rebuild) REBUILD=1 ;;
    -j) JOBS="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo TELEGRAM_API_ID=… TELEGRAM_API_HASH=… bash $0"
id vedit >/dev/null 2>&1 || die "no user vedit — run setup-ubuntu.sh first"
ENV_FILE="$VEDIT_HOME/tg-bot-api.env"
if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" ]]; then
  [[ -f "$ENV_FILE" ]] || die "TELEGRAM_API_ID и TELEGRAM_API_HASH не заданы (их создаёт владелец на https://my.telegram.org → API development tools)"
  ok "id/hash из $ENV_FILE"
else
  [[ "$TELEGRAM_API_ID" =~ ^[0-9]+$ ]] || die "TELEGRAM_API_ID — число"
  [[ "$TELEGRAM_API_HASH" =~ ^[0-9a-f]{32}$ ]] || die "TELEGRAM_API_HASH — 32 шестнадцатеричных символа"
  umask 077
  printf 'TELEGRAM_API_ID=%s\nTELEGRAM_API_HASH=%s\n' "$TELEGRAM_API_ID" "$TELEGRAM_API_HASH" > "$ENV_FILE"
  chown root:vedit "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  umask 022
  ok "$ENV_FILE"
fi

# ── 1. build ──
if [[ $REBUILD -eq 1 || ! -x /usr/local/bin/telegram-bot-api ]]; then
  step "сборка telegram-bot-api (−j $JOBS; на 1 OCPU это 30–60 минут)"
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends make git zlib1g-dev libssl-dev gperf cmake g++ ca-certificates
  SRC=/usr/local/src/telegram-bot-api
  if [[ -d "$SRC/.git" ]]; then
    git -C "$SRC" pull --ff-only -q && git -C "$SRC" submodule update --init --recursive -q
  else
    git clone -q --recursive https://github.com/tdlib/telegram-bot-api.git "$SRC"
  fi
  rm -rf "$SRC/build" && mkdir -p "$SRC/build"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=/usr/local >/dev/null
  cmake --build "$SRC/build" --target install -j "$JOBS"
  ok "$(/usr/local/bin/telegram-bot-api --version 2>/dev/null | head -1 || echo installed)"
else
  ok "уже собран: /usr/local/bin/telegram-bot-api (--rebuild — пересобрать)"
fi

# ── 2–4. data dir, service, cleanup ──
step "служба telegram-bot-api (127.0.0.1:$PORT, --local, пользователь vedit)"
install -d -o vedit -g vedit -m 750 "$DATA" "$DATA/tmp"
cat > /etc/systemd/system/telegram-bot-api.service <<EOF
[Unit]
Description=Telegram Bot API server (local mode, files up to 2000 MB) for vedit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vedit
Group=vedit
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/telegram-bot-api --api-id=\${TELEGRAM_API_ID} --api-hash=\${TELEGRAM_API_HASH} --local --http-ip-address=127.0.0.1 --http-port=$PORT --dir=$DATA --temp-dir=$DATA/tmp --verbosity=1
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/telegram-bot-api-cleanup.service <<EOF
[Unit]
Description=telegram-bot-api: delete downloaded files older than 2 days (the bot keeps its own copies)

[Service]
Type=oneshot
User=vedit
ExecStart=-/usr/bin/find $DATA -mindepth 2 -type f -mtime +1 -not -name '*.binlog' -not -name '*.db' -delete
ExecStart=-/usr/bin/find $DATA/tmp -type f -mmin +360 -delete
EOF
cat > /etc/systemd/system/telegram-bot-api-cleanup.timer <<'EOF'
[Unit]
Description=telegram-bot-api: daily cleanup of downloaded files

[Timer]
OnCalendar=*-*-* 05:00:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ── 5. the bot: after the server, its address from bot-api.env (setup-ubuntu.sh rewrites server.env, not this) ──
install -d /etc/systemd/system/vedit-bot.service.d
cat > /etc/systemd/system/vedit-bot.service.d/bot-api.conf <<EOF
[Unit]
After=telegram-bot-api.service
Wants=telegram-bot-api.service

[Service]
EnvironmentFile=-$VEDIT_HOME/bot-api.env
EOF

systemctl daemon-reload
systemctl enable --now telegram-bot-api.service >/dev/null 2>&1
systemctl enable --now telegram-bot-api-cleanup.timer >/dev/null 2>&1
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
curl -s -o /dev/null "http://127.0.0.1:$PORT/" && ok "отвечает на 127.0.0.1:$PORT" || die "не отвечает — journalctl -u telegram-bot-api -n 50"

# ── switch the bot ──
TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$VEDIT_HOME/app/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
if [[ $SWITCH -eq 1 ]]; then
  step "перевод бота на локальный сервер"
  [[ -n "$TOKEN" ]] || die "нет TELEGRAM_BOT_TOKEN в $VEDIT_HOME/app/.env"
  if grep -qs '^TELEGRAM_API_BASE=' "$VEDIT_HOME/bot-api.env"; then
    ok "уже переведён ($VEDIT_HOME/bot-api.env)"
  else
    # a bot may be served by one server at a time: the cloud must let it go first (it then refuses it ~10 min)
    curl -s "https://api.telegram.org/bot${TOKEN}/logOut" | grep -q '"ok":true' && ok "logOut в облаке" || warn "logOut в облаке не подтвердился (уже был?)"
    printf 'TELEGRAM_API_BASE=http://127.0.0.1:%s\n' "$PORT" > "$VEDIT_HOME/bot-api.env"
    chown root:vedit "$VEDIT_HOME/bot-api.env"
    chmod 640 "$VEDIT_HOME/bot-api.env"
    ok "$VEDIT_HOME/bot-api.env: TELEGRAM_API_BASE=http://127.0.0.1:$PORT"
  fi
  systemctl restart vedit-bot.service
  ok "бот перезапущен; в логе должно быть «Bot API: http://127.0.0.1:$PORT» — journalctl -u vedit-bot -n 30"
else
  step "сервер готов; бот пока ходит в облако"
  echo "  перевести бота:  sudo bash $0 --switch"
  echo "  (или вручную: curl https://api.telegram.org/bot<TOKEN>/logOut; echo TELEGRAM_API_BASE=http://127.0.0.1:$PORT > $VEDIT_HOME/bot-api.env; systemctl restart vedit-bot)"
fi
