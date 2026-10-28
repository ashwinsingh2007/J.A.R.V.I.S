#!/bin/sh
# Package JARVIS.app (Electron) into the project folder.
#   ./build.sh            build the speech sidecar if needed, package, sign
#   JARVIS_SIGN_ID="Developer ID Application: …" ./build.sh   sign with your identity
# Without JARVIS_SIGN_ID it uses "JARVIS Local Signing" (scripts/make-signing-cert.sh) if that's set
# up, else signs ad hoc ("-"); macOS then asks for permissions, and for JARVIS's Keychain key, again
# after every rebuild.
set -e
cd "$(dirname "$0")"
[ -x resources/jarvis-ears ] || sh native/build-ears.sh
[ -x resources/jarvis-hands ] || sh native/build-hands.sh
rm -rf dist JARVIS.app
npx @electron/packager . JARVIS \
  --platform=darwin --arch="$(uname -m | sed 's/x86_64/x64/')" \
  --out=dist --overwrite --asar --asar.unpack="**/*.node" \
  ${ELECTRON_ZIP_DIR:+--electron-zip-dir="$ELECTRON_ZIP_DIR"} \
  --icon=assets/AppIcon.icns \
  --app-bundle-id=io.github.jarvis-voice \
  --app-category-type=public.app-category.productivity \
  --extra-resource=resources/jarvis-ears \
  --extend-info=resources/Info.extra.plist \
  --ignore='^/(dist|models|music|native|\.venv|resources|scripts|prompts|assets|JARVIS\.app)($|/)' \
  --ignore='^/\.git' >/dev/null
APP=$(ls -d dist/JARVIS-darwin-*/JARVIS.app)
mv "$APP" JARVIS.app && rm -rf dist
# No identity given: the local one from scripts/make-signing-cert.sh if it's set up, else ad hoc.
if [ -z "$JARVIS_SIGN_ID" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q '"JARVIS Local Signing"'; then
  JARVIS_SIGN_ID="JARVIS Local Signing"
fi
[ -n "$JARVIS_SIGN_ID" ] || echo "note: signing ad hoc, so macOS asks for permissions again after every build. Run scripts/make-signing-cert.sh once to stop that." >&2
codesign --force --deep --sign "${JARVIS_SIGN_ID:--}" JARVIS.app
echo "built JARVIS.app"
