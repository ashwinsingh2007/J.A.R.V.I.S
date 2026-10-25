#!/bin/sh
# Politely end the Claude Code session in the iTerm tab matching <target>
# (project folder, tab title, tty, or "worker"), then close that tab.
[ -n "$1" ] || { echo "usage: close-session.sh <target>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
target="$1"
[ "$target" = "worker" ] && target="$HOME/.jarvis/worker"
tty=$("$here/terminals.sh" | /usr/bin/python3 -I -c '
import json, sys
needle = sys.argv[1].lower().strip(); terms = json.load(sys.stdin)
def score(t):
    s = 0
    if needle == t["tty"].lower(): s += 100
    if needle == t["cwd"].lower(): s += 95
    if needle and needle == t["project"].lower(): s += 90
    if needle and needle in t["title"].lower(): s += 50
    if needle and needle in t["cwd"].lower(): s += 40
    return s
best = max(terms, key=score, default=None)
if best and score(best) >= 40:
    print(best["tty"])
' "$target") || true
[ -n "$tty" ] || { echo "no iTerm tab matches '$1'" >&2; exit 1; }

osascript - "/dev/$tty" <<'APPLESCRIPT'
on run argv
  set theTty to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            tell s to write text "/exit"
            delay 2.5
            try
              tell s to close
            end try
            return "closed " & theTty
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "tty not found: " & theTty
end run
APPLESCRIPT
