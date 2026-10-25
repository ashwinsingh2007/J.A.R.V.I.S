#!/bin/sh
# Press a key in the iTerm2 tab that matches the target (same matching as
# send.sh). Keys: enter | escape | y | n | up | down | ctrl-c | tab
# Used to answer Claude Code permission prompts ("yes" = enter, "no" = escape).
# Sends the bytes through iTerm's own scripting (write text … newline NO), so no
# macOS Accessibility permission is needed and the user's focus is not stolen.
[ $# -ge 2 ] || { echo "usage: keys.sh <target> <key>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
target="$1"; key="$2"
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
    if needle and needle in t["project"].lower(): s += 30
    return s
best = max(terms, key=score, default=None)
if best and score(best) >= 30:
    print(best["tty"])
' "$target") || true
[ -n "$tty" ] || { echo "no iTerm tab matches '$1'" >&2; exit 1; }

case "$key" in
  enter)  seq='(ASCII character 13)' ;;
  escape) seq='(ASCII character 27)' ;;
  up)     seq='((ASCII character 27) & "[A")' ;;
  down)   seq='((ASCII character 27) & "[B")' ;;
  tab)    seq='(ASCII character 9)' ;;
  ctrl-c) seq='(ASCII character 3)' ;;
  y)      seq='"y"' ;;
  n)      seq='"n"' ;;
  *) echo "unknown key $key" >&2; exit 2 ;;
esac

osascript - "/dev/$tty" "$key" <<APPLESCRIPT
on run argv
  set theTty to item 1 of argv
  set theKey to item 2 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            tell s to write text $seq newline NO
            return "pressed " & theKey & " in " & (name of s)
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "tty not found: " & theTty
end run
APPLESCRIPT
