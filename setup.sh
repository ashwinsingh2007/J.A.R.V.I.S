#!/bin/sh
# One-time setup: Python voice engines, the Kokoro model, the local music
# tracks and the speech sidecar. Safe to run again.
set -e
cd "$(dirname "$0")"

echo "› Node packages"
npm install --no-fund --no-audit

echo "› Speech sidecar (Swift)"
sh native/build-ears.sh
sh native/build-hands.sh

PY=$(command -v python3.12 || command -v python3.11 || command -v python3)
echo "› Python voice engines ($PY)"
[ -x .venv/bin/python3 ] || "$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q edge-tts kokoro-onnx soundfile

echo "› Kokoro voice model (~330 MB)"
mkdir -p models
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f models/kokoro-v1.0.onnx ] || curl -fL --progress-bar -o models/kokoro-v1.0.onnx "$base/kokoro-v1.0.onnx"
[ -f models/voices-v1.0.bin ] || curl -fL --progress-bar -o models/voices-v1.0.bin "$base/voices-v1.0.bin"

echo "› Office Lounge music (Kevin MacLeod, CC BY 4.0)"
mkdir -p music
for t in "Airport Lounge" "Carefree" "Dreamer" "Easy Lemon" "Fresh Air" "Inspired" "Lobby Time" "Local Forecast - Elevator" "Wallpaper"; do
  f="music/$t.mp3"
  [ -f "$f" ] || curl -fsL -o "$f" "https://incompetech.com/music/royalty-free/mp3-royaltyfree/$(echo "$t" | sed 's/ /%20/g').mp3" || echo "  could not download $t (skipped)"
done

echo "Done. Run 'npm start' to try it, or './build.sh' to make JARVIS.app."
