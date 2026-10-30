#!/bin/sh
# Install the jarvis command (scripts/jarvis.mjs) as ~/.local/bin/jarvis, a link to this checkout,
# so it updates with every pull. Adds ~/.local/bin to PATH in ~/.zshrc when it isn't there yet.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
chmod +x "$HERE/jarvis.mjs"
ln -sf "$HERE/jarvis.mjs" "$BIN/jarvis"
echo "Installed: $BIN/jarvis"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    if ! grep -qs '.local/bin' "$HOME/.zshrc"; then
      printf '\n# The jarvis command\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zshrc"
      echo "Added ~/.local/bin to PATH in ~/.zshrc. Open a new terminal, or run: source ~/.zshrc"
    else
      echo "~/.local/bin is in ~/.zshrc but not in this shell's PATH. Open a new terminal."
    fi ;;
esac
command -v node >/dev/null || echo "note: the jarvis command needs Node.js (node) on PATH." >&2
