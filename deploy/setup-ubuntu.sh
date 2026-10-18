#!/usr/bin/env bash
# vedit: one-time (and re-runnable) preparation of a fresh Ubuntu 24.04 server for the Telegram bot.
# Target: Oracle Cloud Always Free, VM.Standard.A1.Flex (ARM64 / aarch64), 1–2 OCPU, 6–12 GB RAM, no GPU.
#
#   sudo bash setup-ubuntu.sh [--with-python-asr] [--no-matte] [--swap-gb 8] [--no-ufw] [--chrome playwright|ppa]
#
# Idempotent: every step checks what is already there. Safe for SSH: port 22 stays open
# (ufw allows 22/tcp before it is enabled; Oracle's own iptables rules in /etc/iptables/rules.v4 are left as is).
# What it does:
#   swapfile (when RAM < 16 GB) · apt upgrade · build tools, ffmpeg, python3-venv, fonts · Node.js 24 (NodeSource)
#   · headless Chrome for ARM64 (Playwright's chromium headless shell, pinned; fallback: xtradeb PPA chromium .deb —
#   never the snap) · system user `vedit`, /opt/vedit/{app,workspace,…} · unattended-upgrades · journald size cap
#   · matte sidecar tools/matte/.venv (MediaPipe speaker cutout for split_news; --no-matte skips it)
#   · ufw (22 only) · systemd units vedit-bot.service + vedit-cleanup.timer (enabled; the bot starts once the
#   code and .env are deployed by deploy/deploy.sh).
set -euo pipefail

WITH_PY_ASR=0
WITH_MATTE=1
SWAP_GB=8
USE_UFW=1
CHROME_MODE=playwright
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.64.1}"
NODE_MAJOR=24
VEDIT_HOME=/opt/vedit

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-python-asr) WITH_PY_ASR=1 ;;
    --no-matte) WITH_MATTE=0 ;;
    --swap-gb) SWAP_GB="$2"; shift ;;
    --no-ufw) USE_UFW=0 ;;
    --chrome) CHROME_MODE="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "run as root: sudo bash $0" >&2; exit 1; fi
ARCH="$(uname -m)"
. /etc/os-release
step "система: ${PRETTY_NAME}, ${ARCH}"
[[ "${VERSION_ID}" == "24.04" ]] || warn "скрипт проверялся на Ubuntu 24.04, здесь ${VERSION_ID}"
[[ "$ARCH" == "aarch64" ]] || warn "ожидался aarch64 (Oracle A1); на ${ARCH} всё тоже должно работать"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# ── swap ──
step "swap"
MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
MEM_MB=$((MEM_KB / 1024))
if (( MEM_MB < 16000 )); then
  if swapon --show=NAME --noheadings | grep -qx /swapfile; then
    ok "/swapfile уже включён ($(swapon --show=SIZE --noheadings /swapfile | tr -d ' '))"
  else
    if [[ ! -f /swapfile ]]; then
      fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024)) status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
    ok "/swapfile ${SWAP_GB} ГБ включён"
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-vedit-swap.conf
  sysctl -q -p /etc/sysctl.d/90-vedit-swap.conf || true
else
  ok "RAM ${MEM_MB} МБ ≥ 16 ГБ — swap не нужен"
fi

# ── packages ──
step "apt update / upgrade"
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade -q
step "базовые пакеты"
apt-get "${APT_OPTS[@]}" install -q --no-install-recommends \
  ca-certificates curl gnupg git build-essential cmake pkg-config ffmpeg \
  python3 python3-venv python3-pip unzip tar xz-utils jq \
  fontconfig fonts-dejavu-core fonts-noto-core fonts-liberation \
  unattended-upgrades ufw libgomp1 software-properties-common
fc-cache -f >/dev/null 2>&1 || true
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 && ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}') с libx264" || warn "ffmpeg без libx264?"

# ── Node.js 24 ──
step "Node.js ${NODE_MAJOR}"
if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge ${NODE_MAJOR} ]]; then
  ok "уже $(node -v)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get "${APT_OPTS[@]}" install -q nodejs
  rm -f /tmp/nodesource_setup.sh
  ok "$(node -v), npm $(npm -v)"
fi

# ── user and folders ──
step "пользователь vedit и /opt/vedit"
if ! id vedit >/dev/null 2>&1; then
  useradd --system --home-dir "$VEDIT_HOME" --create-home --shell /usr/sbin/nologin vedit
  ok "создан пользователь vedit"
else
  ok "пользователь vedit есть"
fi
install -d -o vedit -g vedit -m 755 "$VEDIT_HOME" "$VEDIT_HOME"/{app,workspace,bin,browsers,voice,whisper,cache}
ok "$VEDIT_HOME/{app,workspace,bin,browsers,voice,whisper,cache}"

# ── headless Chrome (ARM64) ──
# puppeteer's chrome-headless-shell has no linux-arm64 build; Ubuntu 24.04's chromium is a snap (avoided on a server).
# Primary: Playwright's chromium headless shell (Microsoft builds it for linux-arm64; same headless-shell family as
# the one HyperFrames downloads on x64, so its fast beginFrame capture works). Pinned by PLAYWRIGHT_VERSION.
# Fallback: the xtradeb PPA's chromium .deb (pinned so nothing else comes from that PPA).
step "headless Chrome (${CHROME_MODE})"
CHROME_LINK="$VEDIT_HOME/bin/chrome-headless-shell"
find_shell() { find "$VEDIT_HOME/browsers" -type f \( -name headless_shell -o -name chrome-headless-shell \) -perm -u+x 2>/dev/null | sort | tail -1; }
CHROME_BIN=""
if [[ "$CHROME_MODE" == "playwright" ]]; then
  if [[ -z "$(find_shell)" ]]; then
    PLAYWRIGHT_BROWSERS_PATH="$VEDIT_HOME/browsers" npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --only-shell chromium || warn "Playwright не поставил chromium headless shell"
  fi
  CHROME_BIN="$(find_shell)"
fi
if [[ -z "$CHROME_BIN" ]]; then
  [[ "$CHROME_MODE" == "playwright" ]] && warn "перехожу на chromium из PPA xtradeb"
  if [[ ! -x /usr/bin/chromium ]] || [[ "$(readlink -f /usr/bin/chromium)" == /snap/* ]]; then
    add-apt-repository -y ppa:xtradeb/apps >/dev/null
    cat > /etc/apt/preferences.d/vedit-xtradeb <<'EOF'
Package: *
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 100

Package: chromium chromium-*
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 700
EOF
    apt-get update -q
    apt-get "${APT_OPTS[@]}" install -q chromium
  fi
  CHROME_BIN=/usr/bin/chromium
fi
chown -R vedit:vedit "$VEDIT_HOME/browsers"
ln -sfn "$CHROME_BIN" "$CHROME_LINK"
if "$CHROME_LINK" --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1 || "$CHROME_LINK" --version >/dev/null 2>&1; then
  ok "$CHROME_LINK → $CHROME_BIN ($("$CHROME_LINK" --version 2>/dev/null | head -1))"
else
  warn "$CHROME_LINK не запускается — проверьте: $CHROME_LINK --version"
fi

# ── optional: Python ASR sidecar (faster-whisper + speechbrain, CPU torch; ~2 GB disk, heavy on 6 GB RAM) ──
if (( WITH_PY_ASR )); then
  step "Python-сайдкар ASR (tools/asr/.venv)"
  VENV="$VEDIT_HOME/app/tools/asr/.venv"
  if [[ -x "$VENV/bin/python" ]]; then
    ok "уже есть: $VENV"
  else
    sudo -u vedit mkdir -p "$VEDIT_HOME/app/tools/asr"
    sudo -u vedit -H python3 -m venv "$VENV"
    sudo -u vedit -H "$VENV/bin/pip" install -q --upgrade pip
    # aarch64 wheels: torch CPU from the PyTorch index; faster-whisper (CTranslate2) and speechbrain from PyPI
    sudo -u vedit -H "$VENV/bin/pip" install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
    sudo -u vedit -H "$VENV/bin/pip" install -q faster-whisper speechbrain scipy
    ok "установлен (сайдкар включается сам; whisper.cpp остаётся основным)"
  fi
fi

# ── Python matte sidecar (MediaPipe selfie segmenter + BlazeFace, ~250 MB disk, CPU only; split_news cuts the speaker out,
#    every preset keeps captions off the faces — stage 23) ──
# The venv lives next to the app (tools/matte/.venv is gitignored, deploy updates keep it). Without it split_news
# falls back to the plain video with a warning.
if (( WITH_MATTE )); then
  step "Python-сайдкар вырезания фона (tools/matte/.venv)"
  MVENV="$VEDIT_HOME/app/tools/matte/.venv"
  MREQ="$VEDIT_HOME/app/tools/matte/requirements-matte.txt"
  if [[ -x "$MVENV/bin/python" ]] && sudo -u vedit -H "$MVENV/bin/python" -I -c "import mediapipe, cv2" >/dev/null 2>&1; then
    ok "уже есть: $MVENV"
  else
    sudo -u vedit mkdir -p "$VEDIT_HOME/app/tools/matte"
    sudo -u vedit -H python3 -m venv "$MVENV"
    sudo -u vedit -H "$MVENV/bin/pip" install -q --upgrade pip
    # mediapipe 1.1.1 has a manylinux_2_28_aarch64 wheel; --no-deps skips its opencv-contrib-python (GUI libs) and
    # sounddevice pins — the headless OpenCV and the rest come from requirements-matte.txt
    sudo -u vedit -H "$MVENV/bin/pip" install -q --no-deps "mediapipe==1.1.1"
    if [[ -f "$MREQ" ]]; then
      sudo -u vedit -H "$MVENV/bin/pip" install -q -r "$MREQ"
    else
      sudo -u vedit -H "$MVENV/bin/pip" install -q "numpy>=1.26,<3" "opencv-python-headless==4.12.0.88" "absl-py~=2.3" "flatbuffers~=25.9" "matplotlib>=3.8" certifi
    fi
    if sudo -u vedit -H "$MVENV/bin/python" -I -c "from mediapipe.tasks.python import vision; import cv2" >/dev/null 2>&1; then
      ok "установлен (модели selfie_segmenter и blaze_face_short_range скачаются при первом рендере или: tools/matte/.venv/bin/python tools/matte/vedit_matte.py model)"
    else
      warn "mediapipe не импортируется — split_news пойдёт без вырезания фона; проверьте: $MVENV/bin/python -c 'import mediapipe'"
    fi
  fi
fi

# ── yt-dlp: videos by YouTube / Shorts / Instagram / TikTok / VK links (bot uploads and «🎯 как в примере») ──
# the official zipapp (Unlicense; runs on python3) in /opt/vedit/bin, owned by vedit so the daily timer can `-U` it
step "yt-dlp (ссылки YouTube / Instagram / TikTok)"
YTDLP="$VEDIT_HOME/bin/yt-dlp"
if [[ -x "$YTDLP" ]]; then
  sudo -u vedit "$YTDLP" -U >/dev/null 2>&1 || true
  ok "yt-dlp $("$YTDLP" --version 2>/dev/null || echo '?')"
elif curl -fsSL -o "$YTDLP.new" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; then
  chmod 755 "$YTDLP.new" && chown vedit:vedit "$YTDLP.new" && mv "$YTDLP.new" "$YTDLP"
  ok "yt-dlp $("$YTDLP" --version 2>/dev/null || echo '?')"
else
  rm -f "$YTDLP.new"
  warn "yt-dlp не скачался — ссылки YouTube/Instagram/TikTok не будут работать (Google Диск, Яндекс Диск, Dropbox работают без него)"
fi

# ── unattended-upgrades ──
step "автообновления безопасности"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "unattended-upgrades включён"

# ── journald ──
step "journald: не больше 500 МБ логов"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/vedit.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemMaxFileSize=50M
MaxRetentionSec=1month
EOF
systemctl restart systemd-journald
ok "SystemMaxUse=500M"

# ── firewall ──
step "файрвол: входящие только 22/tcp"
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}')"
SSH_PORT="${SSH_PORT:-22}"
if [[ -f /etc/iptables/rules.v4 ]]; then
  # Oracle's Ubuntu images: netfilter-persistent loads these rules at boot (SSH allowed, everything else rejected).
  # They are not touched; ufw below only adds its own chains on top.
  grep -Eq -- "--dport ${SSH_PORT}( |$).*ACCEPT" /etc/iptables/rules.v4 && ok "Oracle iptables (rules.v4) пропускает ${SSH_PORT}/tcp" || warn "в /etc/iptables/rules.v4 нет явного ACCEPT для ${SSH_PORT}/tcp — проверьте вручную"
fi
if (( USE_UFW )); then
  ufw allow "${SSH_PORT}/tcp" comment 'ssh' >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  if ufw status | grep -q "Status: active"; then
    ok "ufw уже включён: $(ufw status | grep -c ALLOW) правил ALLOW"
  else
    ufw --force enable >/dev/null
    ok "ufw включён: разрешён только ${SSH_PORT}/tcp (бот работает через long polling, входящие ему не нужны)"
  fi
else
  warn "ufw пропущен (--no-ufw)"
fi

# ── systemd ──
step "systemd: vedit-bot.service и vedit-cleanup.timer"
MEM_MAX_MB=$((MEM_MB * 80 / 100))
# server-only settings: listed AFTER .env in the unit, so a laptop .env cannot override them
cat > "$VEDIT_HOME/server.env" <<EOF
# written by deploy/setup-ubuntu.sh — server-only settings (they win over /opt/vedit/app/.env)
VEDIT_SERVER=1
VEDIT_WORKSPACE=$VEDIT_HOME/workspace
VEDIT_VOICE_DIR=$VEDIT_HOME/voice
VEDIT_WHISPER_BIN=$VEDIT_HOME/whisper/whisper-cli
VEDIT_WHISPER_MODEL=$VEDIT_HOME/whisper/ggml-large-v3-turbo-q5_0.bin
VEDIT_CHROME=$CHROME_LINK
HYPERFRAMES_BROWSER_PATH=$CHROME_LINK
HYPERFRAMES_NO_TELEMETRY=1
PUPPETEER_SKIP_DOWNLOAD=1
XDG_CACHE_HOME=$VEDIT_HOME/cache
VEDIT_YTDLP=$VEDIT_HOME/bin/yt-dlp
EOF
chown root:vedit "$VEDIT_HOME/server.env"
chmod 640 "$VEDIT_HOME/server.env"

cat > /etc/systemd/system/vedit-bot.service <<EOF
[Unit]
Description=vedit Telegram bot (AI video editing)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vedit
Group=vedit
WorkingDirectory=$VEDIT_HOME/app
Environment=VEDIT_SERVER=1 VEDIT_WORKSPACE=$VEDIT_HOME/workspace NODE_ENV=production
EnvironmentFile=-$VEDIT_HOME/app/.env
EnvironmentFile=$VEDIT_HOME/server.env
ExecStart=/usr/bin/node --import tsx src/bot/run.ts
Restart=always
RestartSec=10
TimeoutStopSec=30
KillMode=mixed
MemoryMax=${MEM_MAX_MB}M
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$VEDIT_HOME

[Install]
WantedBy=multi-user.target
EOF

# a backstop to the bot's own retention (VEDIT_RETENTION_DAYS, 7 days, which also knows which uploads a recent
# revision still needs): job folders untouched for 10 days, caches unused for 14 days; users/ is left to the bot
cat > /etc/systemd/system/vedit-cleanup.service <<EOF
[Unit]
Description=vedit: delete workspace job folders older than 10 days and stale caches

[Service]
Type=oneshot
User=vedit
Nice=10
ExecStart=-/usr/bin/find $VEDIT_HOME/workspace -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}-[0-9a-f]+' -mtime +10 -exec rm -rf {} +
ExecStart=-/usr/bin/find $VEDIT_HOME/workspace/_cache $VEDIT_HOME/cache -type f -mtime +14 -delete
ExecStart=-/usr/bin/find $VEDIT_HOME/workspace/_cache -mindepth 1 -type d -empty -delete
ExecStart=-$VEDIT_HOME/bin/yt-dlp -U --quiet
EOF

cat > /etc/systemd/system/vedit-cleanup.timer <<'EOF'
[Unit]
Description=vedit: daily workspace cleanup

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable vedit-bot.service >/dev/null 2>&1
systemctl enable --now vedit-cleanup.timer >/dev/null 2>&1
ok "vedit-bot.service (MemoryMax=${MEM_MAX_MB}M, Nice=5), vedit-cleanup.timer (ежедневно 04:30, задачи старше 10 дней)"
if [[ -f "$VEDIT_HOME/app/package.json" && -d "$VEDIT_HOME/app/node_modules" ]]; then
  systemctl restart vedit-bot.service && ok "бот перезапущен"
else
  ok "код ещё не залит: с ноутбука выполните deploy/deploy.sh — он зальёт код, .env и запустит бота"
fi

step "готово"
echo "  Chrome:   $CHROME_LINK"
echo "  настройки сервера: $VEDIT_HOME/server.env (поверх $VEDIT_HOME/app/.env)"
echo "  логи:     journalctl -u vedit-bot -f"
