#!/usr/bin/env bash
# whisper.cpp from source for Linux (ARM64 server or x64), the same model the repo uses on Windows.
#
#   bash deploy/build-whisper.sh [--prefix /opt/vedit/whisper] [--ref v1.9.5] [--model turbo|small|medium] [--jobs N]
#
# Result: <prefix>/whisper-cli (static, -DGGML_NATIVE=ON: tuned for this CPU) and <prefix>/<model>.bin.
# Point vedit at them with VEDIT_WHISPER_BIN / VEDIT_WHISPER_MODEL (deploy/setup-ubuntu.sh writes them into
# /opt/vedit/server.env). Without --prefix the binary lands in vendor/whisper/bin/ (the default path the code
# looks at on Linux). Idempotent: an existing binary of the same ref and an existing model are kept.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=""
REF="${WHISPER_REF:-v1.9.5}"
MODEL=turbo
JOBS="$(nproc 2>/dev/null || echo 2)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --jobs) JOBS="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$MODEL" in
  turbo) MODEL_FILE=ggml-large-v3-turbo-q5_0.bin ;;
  small) MODEL_FILE=ggml-small.bin ;;
  medium) MODEL_FILE=ggml-medium-q5_0.bin ;;
  *) echo "model: turbo | small | medium" >&2; exit 2 ;;
esac

if [[ -n "$PREFIX" ]]; then
  BIN_DIR="$PREFIX"; MODEL_DIR="$PREFIX"; SRC="$PREFIX/src"
else
  BIN_DIR="$ROOT/vendor/whisper/bin"; MODEL_DIR="$ROOT/vendor/whisper"; SRC="$ROOT/vendor/whisper/src"
fi
mkdir -p "$BIN_DIR" "$MODEL_DIR"

# ── binary ──
STAMP="$BIN_DIR/.whisper-ref"
if [[ -x "$BIN_DIR/whisper-cli" && "$(cat "$STAMP" 2>/dev/null)" == "$REF" ]]; then
  echo "✔ whisper-cli $REF уже собран: $BIN_DIR/whisper-cli"
else
  for tool in git cmake c++; do command -v "$tool" >/dev/null || { echo "✖ нет $tool (sudo apt-get install -y git cmake build-essential)" >&2; exit 1; }; done
  if [[ -d "$SRC/.git" ]]; then
    git -C "$SRC" fetch -q --depth 1 origin tag "$REF"
  else
    rm -rf "$SRC"
    git clone -q --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$SRC"
  fi
  git -C "$SRC" -c advice.detachedHead=false checkout -q "$REF"
  echo "▸ сборка whisper.cpp $REF ($(uname -m), $JOBS потоков)…"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF >/dev/null
  cmake --build "$SRC/build" --config Release -j "$JOBS" --target whisper-cli >/dev/null
  install -m 755 "$SRC/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
  echo "$REF" > "$STAMP"
  rm -rf "$SRC/build"
  echo "✔ $BIN_DIR/whisper-cli"
fi

# ── model ──
if [[ -s "$MODEL_DIR/$MODEL_FILE" ]]; then
  echo "✔ модель $MODEL_FILE уже есть"
else
  echo "▸ скачиваю $MODEL_FILE…"
  curl -fL --retry 3 -o "$MODEL_DIR/$MODEL_FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"
  mv "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_DIR/$MODEL_FILE"
  echo "✔ $MODEL_DIR/$MODEL_FILE ($(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1))"
fi

"$BIN_DIR/whisper-cli" --help >/dev/null 2>&1 && echo "✔ whisper-cli запускается" || { echo "✖ whisper-cli не запускается" >&2; exit 1; }
