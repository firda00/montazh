#!/usr/bin/env bash
# Runs ON THE SERVER as root (deploy/deploy.sh copies it to /tmp and calls it through sudo):
#   remote-update.sh --commit <sha> [--bundle /tmp/vedit-xxx.bundle] [--env /tmp/vedit-xxx.env] [--strict] [--no-restart]
# Checks out the commit in /opt/vedit/app (as user vedit), installs npm dependencies when the lockfile changed,
# builds whisper.cpp / fetches Piper when missing, installs the .env, runs `vedit doctor --bot` with the
# service's environment, restarts vedit-bot and prints the last log lines. Idempotent.
set -euo pipefail

VEDIT_HOME=/opt/vedit
APP="$VEDIT_HOME/app"
COMMIT=""
BUNDLE=""
ENV_FILE=""
STRICT=0
RESTART=1
PIPER_RELEASE=2023.11.14-2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift ;;
    --bundle) BUNDLE="$2"; shift ;;
    --env) ENV_FILE="$2"; shift ;;
    --strict) STRICT=1 ;;
    --no-restart) RESTART=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -n "$COMMIT" ]] || { echo "--commit is required" >&2; exit 2; }
id vedit >/dev/null 2>&1 || { echo "✖ нет пользователя vedit — сначала deploy/setup-ubuntu.sh (deploy.sh --setup)" >&2; exit 1; }

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
as_vedit() { sudo -u vedit -H env HOME="$VEDIT_HOME" "$@"; }

# ── code ──
step "код: ${COMMIT:0:12}"
install -d -o vedit -g vedit "$APP" "$VEDIT_HOME/cache" "$VEDIT_HOME/workspace"
if [[ ! -d "$APP/.git" ]]; then
  # init + fetch instead of clone: the folder may already hold ignored files (tools/asr/.venv, .env)
  as_vedit git -C "$APP" init -q
  as_vedit git -C "$APP" config advice.detachedHead false
fi
if ! as_vedit git -C "$APP" cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  [[ -n "$BUNDLE" && -f "$BUNDLE" ]] || { echo "✖ коммита ${COMMIT} нет на сервере и бандл не передан" >&2; exit 1; }
  # the upload dir is private to the ssh user (mktemp -d, 700): hand vedit its own copy
  INCOMING="$VEDIT_HOME/cache/incoming.bundle"
  install -o vedit -g vedit -m 644 "$BUNDLE" "$INCOMING"
  as_vedit git -C "$APP" bundle verify -q "$INCOMING" >/dev/null
  as_vedit git -C "$APP" fetch -q "$INCOMING" "+refs/vedit/deploy:refs/vedit/deployed"
  rm -f "$INCOMING"
fi
PREV="$(as_vedit git -C "$APP" rev-parse -q --verify HEAD 2>/dev/null || echo none)"
OLD_LOCK="$(as_vedit git -C "$APP" show HEAD:package-lock.json 2>/dev/null | sha256sum | cut -c1-16 || true)"
as_vedit git -C "$APP" checkout -q --force --detach "$COMMIT"
as_vedit git -C "$APP" tag -f "deployed-$(date -u +%Y%m%d-%H%M%S)" "$COMMIT" >/dev/null
echo "$(date -u +%FT%TZ) ${COMMIT} (было ${PREV})" >> "$VEDIT_HOME/deploys.log"
ok "$(as_vedit git -C "$APP" log -1 --format='%h %s' | cut -c1-100)"

# ── npm ──
step "зависимости npm"
NEW_LOCK="$(sha256sum "$APP/package-lock.json" | cut -c1-16)"
STAMP="$VEDIT_HOME/.npm-lock"
if [[ ! -d "$APP/node_modules" || "$(cat "$STAMP" 2>/dev/null)" != "$NEW_LOCK" ]]; then
  # tsx and hyperframes are runtime dependencies (package.json "dependencies"); typescript / @types stay dev-only
  (cd "$APP" && as_vedit env PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  echo "$NEW_LOCK" > "$STAMP"
  ok "npm ci --omit=dev (lock ${OLD_LOCK:-—} → ${NEW_LOCK})"
else
  ok "package-lock.json не менялся — пропуск"
fi

# ── whisper.cpp ──
step "whisper.cpp"
if [[ -x "$VEDIT_HOME/whisper/whisper-cli" && -s "$VEDIT_HOME/whisper/ggml-large-v3-turbo-q5_0.bin" ]]; then
  ok "есть: $VEDIT_HOME/whisper/whisper-cli"
else
  as_vedit bash "$APP/deploy/build-whisper.sh" --prefix "$VEDIT_HOME/whisper" --jobs "$(nproc)"
fi

# ── Piper (rhasspy release for this arch; vedit would also fetch it on first use) ──
step "Piper"
case "$(uname -m)" in
  aarch64|arm64) PIPER_ASSET=piper_linux_aarch64.tar.gz ;;
  x86_64) PIPER_ASSET=piper_linux_x86_64.tar.gz ;;
  *) PIPER_ASSET="" ;;
esac
if [[ -x "$VEDIT_HOME/voice/bin/piper/piper" ]]; then
  ok "есть: $VEDIT_HOME/voice/bin/piper/piper"
elif [[ -n "$PIPER_ASSET" ]]; then
  as_vedit mkdir -p "$VEDIT_HOME/voice/bin"
  as_vedit curl -fsSL --retry 3 -o "$VEDIT_HOME/voice/bin/$PIPER_ASSET" "https://github.com/rhasspy/piper/releases/download/$PIPER_RELEASE/$PIPER_ASSET"
  as_vedit tar -xzf "$VEDIT_HOME/voice/bin/$PIPER_ASSET" -C "$VEDIT_HOME/voice/bin"
  rm -f "$VEDIT_HOME/voice/bin/$PIPER_ASSET"
  if as_vedit "$VEDIT_HOME/voice/bin/piper/piper" --help >/dev/null 2>&1; then ok "Piper $PIPER_RELEASE ($PIPER_ASSET)"; else warn "piper не запускается — голос Piper будет недоступен"; fi
else
  warn "нет сборки Piper для $(uname -m)"
fi

# ── .env ──
if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  step ".env"
  install -o vedit -g vedit -m 600 "$ENV_FILE" "$APP/.env"
  rm -f "$ENV_FILE"
  ok "$APP/.env обновлён (600, vedit); ключей: $(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$APP/.env")"
fi
[[ -f "$APP/.env" ]] || warn "нет $APP/.env — бот не запустится без TELEGRAM_BOT_TOKEN"

# ── which Chrome HyperFrames itself resolves (HYPERFRAMES_BROWSER_PATH from server.env) ──
HF_CHROME="$(grep -E '^HYPERFRAMES_BROWSER_PATH=' "$VEDIT_HOME/server.env" | cut -d= -f2-)"
if [[ -n "$HF_CHROME" ]]; then
  (cd "$APP" && as_vedit env HYPERFRAMES_BROWSER_PATH="$HF_CHROME" HYPERFRAMES_NO_TELEMETRY=1 node node_modules/hyperframes/bin/hyperframes.mjs browser path 2>&1 | tail -1 | sed 's/^/  hyperframes browser path: /') || warn "hyperframes browser path не ответил"
fi

# ── self-check with exactly the service's environment ──
step "vedit doctor --bot"
DOCTOR_OK=1
systemd-run --quiet --wait --pipe --collect -p User=vedit -p Group=vedit -p WorkingDirectory="$APP" \
  -p EnvironmentFile=-"$APP/.env" -p EnvironmentFile="$VEDIT_HOME/server.env" -p Environment=HOME="$VEDIT_HOME" \
  /usr/bin/node --import tsx src/cli.ts doctor --bot || DOCTOR_OK=0
if (( ! DOCTOR_OK )); then
  if (( STRICT )); then echo "✖ doctor: не хватает обязательного — бот НЕ перезапущен (--strict)" >&2; exit 1; fi
  warn "doctor нашёл недостающее (см. выше) — бот всё равно перезапускается; задачи, которым это нужно, будут падать"
fi

# ── restart ──
if (( RESTART )); then
  step "перезапуск vedit-bot"
  chown -R vedit:vedit "$VEDIT_HOME/workspace"
  systemctl restart vedit-bot
  sleep 6
  if systemctl is-active --quiet vedit-bot; then ok "vedit-bot: active"; else warn "vedit-bot не active: $(systemctl is-active vedit-bot || true)"; fi
  journalctl -u vedit-bot -n 30 --no-pager -o short-iso || true
fi
