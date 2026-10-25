#!/bin/sh
# Open a new iTerm2 window running Claude Code in the given directory and
# optionally send a first prompt once it has started. Prints the tty so the
# caller can address this tab later with send.sh / keys.sh / read.sh.
[ -n "$1" ] || { echo "usage: open-session.sh <directory> [first prompt]" >&2; exit 2; }
dir="$1"; shift
prompt="$*"
[ -d "$dir" ] || { echo "no such directory: $dir" >&2; exit 1; }
osascript - "$dir" "$prompt" <<'APPLESCRIPT'
on run argv
  set dir to item 1 of argv
  set p to item 2 of argv
  tell application "iTerm"
    activate
    set w to (create window with default profile)
    tell current session of w
      write text "cd " & quoted form of dir & " && claude"
      set theTty to tty
    end tell
    if p is not "" then
      delay 7
      tell current session of w to write text p
    end if
    return "opened Claude Code in " & dir & " on " & theTty
  end tell
end run
APPLESCRIPT
