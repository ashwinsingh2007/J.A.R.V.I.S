#!/bin/sh
# Type text into the iTerm2 tab running Claude Code for the given target and
# press Enter. Target matches (case-insensitive) the project folder name, the
# tab title, the working directory path, or the tty (e.g. ttys003).
[ $# -ge 2 ] || { echo "usage: send.sh <target> <text...>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
target="$1"; shift
text="$*"
tty=$(/usr/bin/python3 -I - "$here/terminals.sh" "$target" <<'PY'
import json, subprocess, sys
terms = json.loads(subprocess.run([sys.argv[1]], capture_output=True, text=True, timeout=15).stdout or "[]")
needle = sys.argv[2].lower().strip()
def score(t):
    s = 0
    if needle == t["tty"].lower(): s += 100
    if needle and needle == t["project"].lower(): s += 90
    if needle and needle in t["title"].lower(): s += 50
    if needle and needle in t["cwd"].lower(): s += 40
    if needle and needle in t["project"].lower(): s += 30
    if t["claude"]: s += 5
    return s
best = max(terms, key=score, default=None)
if not best or score(best) < 30:
    sys.exit(1)
print(best["tty"])
PY
) || { echo "no iTerm tab matches '$target'" >&2; exit 1; }

osascript - "/dev/$tty" "$text" <<'APPLESCRIPT'
on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            -- Type the text without a newline, then press Return on its own:
            -- Claude Code treats a long burst as a paste, so a trailing
            -- newline would only add a line instead of submitting.
            tell s to write text theText newline NO
            delay 0.5
            tell s to write text (ASCII character 13) newline NO
            return "typed into " & (name of s)
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "tty not found: " & theTty
end run
APPLESCRIPT
