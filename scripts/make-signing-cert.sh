#!/bin/sh
# Make a local code-signing certificate, "JARVIS Local Signing", in your login keychain, once.
#
# Without a signing identity, build.sh signs JARVIS ad hoc, which gives every build a new signature.
# macOS then treats each build as a new app: it asks for the microphone again, and it asks to let
# JARVIS read its own key from the Keychain ("JARVIS wants to use your confidential information"),
# with JARVIS frozen until you answer. Signed with this certificate, every build keeps the same
# identity, so "Always Allow" and the permissions you gave stay.
#
# The certificate only signs your own builds on this Mac. macOS asks for your login password once,
# to trust it for code signing. build.sh uses it from then on, unless JARVIS_SIGN_ID says otherwise.
set -e
NAME="JARVIS Local Signing"
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" is already set up."
  exit 0
fi
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
cat > "$DIR/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$DIR/cert.cnf" -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
PASS=$(openssl rand -hex 16)
# -legacy: the keychain can't read the newer PKCS#12 encryption OpenSSL 3 uses by default.
openssl pkcs12 -export -legacy -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name "$NAME" -out "$DIR/id.p12" -passout "pass:$PASS" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name "$NAME" -out "$DIR/id.p12" -passout "pass:$PASS"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
security import "$DIR/id.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Trusting it for code signing: macOS asks for your login password."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$DIR/cert.pem"
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "Done. Run ./build.sh: builds are now signed as \"$NAME\"."
else
  echo "The certificate was added but isn't trusted for code signing yet." >&2
  exit 1
fi
