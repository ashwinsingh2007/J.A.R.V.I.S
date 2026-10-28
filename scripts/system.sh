#!/bin/sh
# A view of this Mac: what's running, how busy it is, what's installed and what can be cleaned.
#   system.sh overview             -> load, CPU, memory, disk, battery and uptime in one go
#   system.sh top [cpu|mem] [n]    -> the busiest processes (default: cpu, 10)
#   system.sh apps                 -> apps open right now
#   system.sh installed            -> every installed app with its version, plus Homebrew packages
#   system.sh sizes [n]            -> the biggest installed apps (default 15)
#   system.sh disk                 -> free space, and the biggest folders in your home
#   system.sh junk                 -> how much each cleanable kind of junk takes
#   system.sh clean <kind>         -> clean one kind: caches | logs | trash | xcode | npm | brew
#                                     Only after the user said yes. Nothing else can be cleaned here.
#   system.sh quit <App Name>      -> politely quit an app (it can ask to save first)
cmd="$1"; shift 2>/dev/null
size() { k=$(du -sk "$1" 2>/dev/null | awk '{ print $1 }'); [ -n "$k" ] && awk -v k="$k" 'BEGIN { printf "%.1f GB", k / 1048576 }' || printf 'unknown (no access)'; }

case "$cmd" in
  overview)
    echo "uptime: $(uptime | sed 's/^ *//')"
    echo "cpu: $(sysctl -n machdep.cpu.brand_string 2>/dev/null), $(sysctl -n hw.ncpu) cores"
    top -l 1 -n 0 | grep -E '^(CPU usage|PhysMem|Processes)'
    memory_pressure 2>/dev/null | tail -1
    echo "swap: $(sysctl -n vm.swapusage)"
    echo "disk: $(df -h / | tail -1 | awk '{ print $4 " free of " $2 " (" $5 " used)" }')"
    pmset -g batt | tail -1 | sed 's/^ *-InternalBattery-0 *(id=[0-9]*)[[:space:]]*/battery: /'
    echo "busiest:"; ps -Ao pcpu=,pmem=,comm= -r | head -5 | awk '{ c = $3; for (i = 4; i <= NF; i++) c = c " " $i; sub(/.*\//, "", c); printf "  %5s%% cpu %5s%% mem  %s\n", $1, $2, c }'
    ;;
  top)
    sort=cpu; n=10
    case "$1" in mem|cpu) sort="$1"; shift ;; esac
    [ -n "$1" ] && n="$1"
    flag=-r; [ "$sort" = mem ] && flag=-m
    ps -Ao pid=,pcpu=,pmem=,rss=,etime=,comm= $flag | head -"$n" | awk '{ c = $6; for (i = 7; i <= NF; i++) c = c " " $i; sub(/.*\//, "", c); printf "%6s %5s%% cpu %5s%% mem %6.0f MB  up %-11s %s\n", $1, $2, $3, $4 / 1024, $5, c }'
    ;;
  apps)
    osascript -e 'tell application "System Events" to get name of every application process whose background only is false' | tr ',' '\n' | sed 's/^ *//'
    ;;
  installed)
    for d in /Applications "$HOME/Applications" /Applications/Utilities; do
      [ -d "$d" ] || continue
      for a in "$d"/*.app; do
        [ -d "$a" ] || continue
        v=$(defaults read "$a/Contents/Info" CFBundleShortVersionString 2>/dev/null)
        echo "$(basename "$a" .app)${v:+ $v}"
      done
    done | sort -f
    if command -v brew >/dev/null 2>&1; then
      echo; echo "homebrew formulae: $(brew list --formula 2>/dev/null | wc -l | tr -d ' ')"
      echo "homebrew casks: $(brew list --cask 2>/dev/null | tr '\n' ' ')"
    fi
    ;;
  sizes)
    n="${1:-15}"
    du -sk /Applications/*.app "$HOME"/Applications/*.app 2>/dev/null | sort -rn | head -"$n" | awk '{ s = $1; $1 = ""; sub(/^ /, ""); sub(/.*\//, ""); printf "%7.1f GB  %s\n", s / 1048576, $0 }'
    ;;
  disk)
    df -h / | tail -1 | awk '{ print "free: " $4 " of " $2 " (" $5 " used)" }'
    echo "biggest folders in your home:"
    du -sk "$HOME"/* "$HOME"/.[!.]* 2>/dev/null | sort -rn | head -12 | awk '{ s = $1; $1 = ""; sub(/^ /, ""); printf "  %7.1f GB  %s\n", s / 1048576, $0 }'
    ;;
  junk)
    echo "caches  $(size "$HOME/Library/Caches")  app caches, rebuilt when needed"
    echo "logs    $(size "$HOME/Library/Logs")  old app logs"
    echo "trash   $(size "$HOME/.Trash")  the Trash"
    [ -d "$HOME/Library/Developer/Xcode/DerivedData" ] && echo "xcode   $(size "$HOME/Library/Developer/Xcode/DerivedData")  Xcode build files"
    [ -d "$HOME/.npm/_cacache" ] && echo "npm     $(size "$HOME/.npm/_cacache")  npm download cache"
    command -v brew >/dev/null 2>&1 && echo "brew    $(size "$(brew --cache)")  Homebrew downloads"
    old=$(find "$HOME/Downloads" -maxdepth 1 -mtime +90 2>/dev/null | wc -l | tr -d ' ')
    echo "downloads: $(size "$HOME/Downloads") in Downloads, $old item(s) older than 90 days (never cleaned here; the user decides)"
    ;;
  clean)
    empty() { [ -d "$1" ] || { echo "nothing at $1"; return; }; before=$(size "$1"); find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; echo "cleaned $1: was $before, now $(size "$1")"; }
    case "$1" in
      caches) empty "$HOME/Library/Caches" ;;
      logs)   empty "$HOME/Library/Logs" ;;
      trash)  osascript -e 'tell application "Finder" to empty trash' >/dev/null && echo "emptied the Trash" ;;
      xcode)  empty "$HOME/Library/Developer/Xcode/DerivedData" ;;
      npm)    empty "$HOME/.npm/_cacache" ;;
      brew)   brew cleanup -s 2>&1 | tail -3 ;;
      *) echo "clean what? caches | logs | trash | xcode | npm | brew" >&2; exit 2 ;;
    esac
    ;;
  quit)
    [ -n "$1" ] || { echo "quit which app?" >&2; exit 2; }
    osascript -e "tell application \"$1\" to quit" && echo "asked $1 to quit"
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    [ -z "$cmd" ] || exit 2
    ;;
esac
