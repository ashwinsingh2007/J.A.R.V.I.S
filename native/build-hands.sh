#!/bin/sh
# Build the screen-control helper (Swift) into resources/jarvis-hands.
set -e
cd "$(dirname "$0")/hands"
mkdir -p ../../resources
swiftc -O main.swift -o ../../resources/jarvis-hands 2>&1 | grep -E "error" || true
[ -x ../../resources/jarvis-hands ] && echo "built resources/jarvis-hands"
