#!/usr/bin/env bash
# agent-video-vision: self-setup for fresh (cloud) machines.
# Installs the Python runtime and Fluid Speech Mini, then points the plugin at them.
# Safe to run any number of times; it does only what is missing.
# Runs in the background from start.sh at session start; run it in the foreground
# (bash bootstrap.sh) to set up on demand or to see what failed.
set -uo pipefail

DATA="$HOME/.agent-video-vision"
MODELS="$DATA/models"
MODEL_DIR="$MODELS/fluidvoice-fluid-speech-mini"
# Fluid Speech Mini by FluidVoice (CC BY 4.0), sherpa-onnx conversion, GitHub-hosted
# (huggingface.co, where the original lives, is blocked on cloud machines).
MODEL_URL="https://github.com/alcun/heyra-desktop/releases/download/model-fluid-speech-mini/fluidvoice-fluid-speech-mini.tar.bz2"
MODEL_SHA="20caa640d57487093d6c4941a2f5261608d28f77f07c4ea90952b5efb9293a0c"
LOCK="$DATA/.bootstrap.lock"

mkdir -p "$MODELS"
# one run at a time; a lock older than 20 minutes is treated as stale
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else
    echo "bootstrap already running; waiting"; while [ -d "$LOCK" ]; do sleep 2; done; exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT
echo "== bootstrap $(date -u +%FT%TZ)"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 not found"; exit 1; }

# 1. Python packages: sherpa-onnx runs the model; yt-dlp lets the plugin take video URLs
if ! "$PY" -c "import sherpa_onnx, numpy" 2>/dev/null || ! command -v yt-dlp >/dev/null; then
  echo "== installing sherpa-onnx, numpy, yt-dlp"
  "$PY" -m pip install -q sherpa-onnx numpy yt-dlp 2>/dev/null \
    || "$PY" -m pip install -q --break-system-packages sherpa-onnx numpy yt-dlp \
    || echo "pip install failed"
fi

# 2. The model (about 300 MB, checksum-verified)
if [ ! -f "$MODEL_DIR/encoder.q4.onnx" ] || [ ! -f "$MODEL_DIR/tokens.txt" ]; then
  echo "== downloading Fluid Speech Mini"
  TMP="$MODELS/.fsm.tar.bz2"
  if curl -fsSL --retry 3 -o "$TMP" "$MODEL_URL"; then
    GOT="$( (command -v sha256sum >/dev/null && sha256sum "$TMP" || shasum -a 256 "$TMP") | cut -d' ' -f1)"
    if [ "$GOT" = "$MODEL_SHA" ]; then
      rm -rf "$MODEL_DIR"; tar xjf "$TMP" -C "$MODELS" 2>/dev/null
      find "$MODELS" -name '._*' -delete
      echo "model ready at $MODEL_DIR"
    else
      echo "checksum mismatch ($GOT); model not installed"
    fi
  else
    echo "model download failed"
  fi
  rm -f "$TMP"
fi

# 3. Point the plugin at them (only when nothing else has been configured)
node -e '
  const fs = require("fs"), p = process.argv[1];
  let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  if (!c.engine || c.engine === "unconfigured" || c.engine === "fluid-speech") {
    c.engine = "fluid-speech"; c.fluid_model_dir = process.argv[2]; c.fluid_python = process.argv[3];
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    console.log("config: fluid-speech ->", process.argv[2]);
  } else console.log("config: keeping engine", c.engine);
' "$DATA/config.json" "$MODEL_DIR" "$PY"

command -v ffmpeg >/dev/null || echo "WARNING: ffmpeg not found; frames and audio need it"
echo "== bootstrap done"
