#!/bin/sh
# Small, fixed menu of Mac actions so the brain's shell allowlist stays narrow.
#   mac.sh volume <0-100> | mute | unmute
#   mac.sh screenshot            -> prints path of a PNG of the main screen (read it with the Read tool to see it)
#   mac.sh front                 -> frontmost app name + window title
#   mac.sh apps                  -> running apps
#   mac.sh clipboard             -> clipboard text
#   mac.sh notify <title> <body> -> macOS notification
#   mac.sh battery | disk | memory | uptime
#   mac.sh quit <App Name>       -> politely quit an app
set -e
cmd="$1"; shift || true
case "$cmd" in
  volume)   osascript -e "set volume output volume $1"; echo "volume $1" ;;
  mute)     osascript -e "set volume with output muted"; echo muted ;;
  unmute)   osascript -e "set volume without output muted"; echo unmuted ;;
  screenshot)
    f="$HOME/.jarvis/screen-$(date +%H%M%S).png"
    screencapture -x -t png "$f" && sips -Z 1600 "$f" >/dev/null 2>&1; echo "$f" ;;
  front)    osascript -e 'tell application "System Events" to set p to first application process whose frontmost is true' -e 'tell application "System Events" to set t to ""' -e 'try' -e 'tell application "System Events" to set t to name of front window of p' -e 'end try' -e 'return (name of p) & " — " & t' ;;
  apps)     osascript -e 'tell application "System Events" to get name of every application process whose background only is false' ;;
  clipboard) pbpaste | head -c 4000 ;;
  notify)   osascript -e "display notification \"$2\" with title \"$1\""; echo sent ;;
  battery)  pmset -g batt | tail -1 ;;
  disk)     df -h / | tail -1 ;;
  memory)   vm_stat | head -5; echo; top -l 1 -o mem -n 5 -stats pid,command,mem | tail -6 ;;
  uptime)   uptime ;;
  quit)     osascript -e "tell application \"$1\" to quit"; echo "quit $1" ;;
  *) echo "unknown action: $cmd" >&2; exit 2 ;;
esac
