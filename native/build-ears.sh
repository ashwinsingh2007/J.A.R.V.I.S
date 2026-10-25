#!/bin/sh
# Build the microphone / speech sidecar (Swift) into resources/jarvis-ears.
set -e
cd "$(dirname "$0")/ears"
swift build -c release 2>&1 | grep -E "error|warning: unre" || true
mkdir -p ../../resources
cp .build/release/JarvisEars ../../resources/jarvis-ears
echo "built resources/jarvis-ears"
