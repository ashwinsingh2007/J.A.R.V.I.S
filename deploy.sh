#!/bin/sh
# Rebuild and restart JARVIS.app.
set -e
cd "$(dirname "$0")"
./build.sh
pkill -f "JARVIS.app/Contents/MacOS/JARVIS" 2>/dev/null || true
sleep 1
open JARVIS.app
