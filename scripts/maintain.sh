#!/bin/sh
# EDITH's tools for maintaining JARVIS. Changes are made in a git worktree, never in the checkout
# JARVIS runs from (its prompts and scripts are read live from there), and reach main only through a
# pull request the user merges.
#
#   maintain.sh status                 how JARVIS is doing: processes, CPU and RAM, recent errors
#   maintain.sh start <name>           new worktree on branch maintain/<name> from origin/main; prints its path
#   maintain.sh check <dir>            syntax check and unit tests in that worktree
#   maintain.sh e2e <dir> [suite]      build the app in that worktree and run an end-to-end suite (default hud)
#   maintain.sh finish <dir>           remove the worktree (after its pull request is merged or dropped)
#   maintain.sh apply                  after the user merged: pull main, build JARVIS.app, restart when idle
#   maintain.sh restart [reason]       ask JARVIS to restart itself as soon as it is idle
#
# Build settings (the signing identity, so macOS keeps JARVIS's permissions) come from
# ~/.jarvis/build.env: lines of ELECTRON_ZIP_DIR=… and JARVIS_SIGN_ID=….
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${JARVIS_STATE_DIR:-$HOME/.jarvis}
WORK="$STATE/maintain"

die() { echo "maintain: $*" >&2; exit 1; }

# Only these two keys, read as plain values (the file is never run).
load_build_env() {
  [ -f "$STATE/build.env" ] || return 0
  ELECTRON_ZIP_DIR=$(sed -n 's/^ELECTRON_ZIP_DIR=//p' "$STATE/build.env" | tail -1 | sed "s|^~|$HOME|")
  JARVIS_SIGN_ID=$(sed -n 's/^JARVIS_SIGN_ID=//p' "$STATE/build.env" | tail -1)
  export ELECTRON_ZIP_DIR JARVIS_SIGN_ID
}

# A worktree made here: inside $WORK, and a git checkout.
worktree() {
  d=$(cd "$1" 2>/dev/null && pwd) || die "no such folder: $1"
  case "$d" in "$WORK"/*) ;; *) die "$1 is not a maintenance worktree (they live in $WORK)" ;; esac
  [ -e "$d/.git" ] || die "$1 is not a git worktree"
  echo "$d"
}

cmd=$1; [ $# -gt 0 ] && shift
case "$cmd" in
  status)
    # -a: whoever asks is usually one of JARVIS's own agents, and pgrep leaves out its own ancestors
    # without it. The copy built from this checkout first, so a test build running beside it isn't taken.
    pid=$(pgrep -a -f "^$ROOT/JARVIS.app/Contents/MacOS/JARVIS" | head -1 || true)
    [ -n "$pid" ] || pid=$(pgrep -a -x JARVIS | head -1 || true)
    if [ -z "$pid" ]; then echo "JARVIS is not running"; else
      ps -A -o pid=,ppid=,%cpu=,rss=,etime=,command= | awk -v root="$pid" '
        { pid[NR]=$1; pp[NR]=$2; line[NR]=$0 }
        END { keep[root]=1; for (k=0;k<6;k++) for (i=1;i<=NR;i++) if (keep[pp[i]]) keep[pid[i]]=1
              for (i=1;i<=NR;i++) if (keep[pid[i]]) { split(line[i], f, " "); c+=f[3]; r+=f[4]; n++ }
              printf "JARVIS is running (pid %s): %d processes, %.0f%% CPU, %d MB RAM\n", root, n, c, r/1024 }'
    fi
    echo "--- recent problems in the log ---"
    grep -iE 'error|failed|crash|exception|not running|rejected' "$STATE/jarvis.log" 2>/dev/null | tail -15 || true
    echo "--- brain ---"
    grep -E 'brain: (provider|started claude)' "$STATE/jarvis.log" 2>/dev/null | tail -2 || true
    echo "--- checkout ---"
    git -C "$ROOT" status --short --branch | head -10
    ;;
  start)
    name=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-40)
    [ -n "$name" ] || die "give the change a short name, for example fix-clock"
    d="$WORK/$name"
    [ -e "$d" ] && die "$d already exists"
    mkdir -p "$WORK"
    git -C "$ROOT" fetch -q origin main
    git -C "$ROOT" worktree add -q -b "maintain/$name" "$d" origin/main
    # What git doesn't hold: dependencies, the voice model, the speech and screen helpers.
    for x in node_modules .venv models music resources/jarvis-ears resources/jarvis-hands; do
      [ -e "$ROOT/$x" ] && [ ! -e "$d/$x" ] && ln -s "$ROOT/$x" "$d/$x"
    done
    echo "$d"
    ;;
  check)
    d=$(worktree "${1:-}")
    cd "$d" && npm run -s check && npm test 2>&1 | grep -E '^(ℹ (pass|fail))|^✖|not ok' || true
    ;;
  e2e)
    d=$(worktree "${1:-}")
    load_build_env
    cd "$d" && ./build.sh >/dev/null && node test/e2e.mjs "${2:-hud}" 2>&1 | grep -E '✗|passed|crashed'
    ;;
  finish)
    d=$(worktree "${1:-}")
    git -C "$ROOT" worktree remove --force "$d"
    echo "removed $d"
    ;;
  apply)
    [ "$(git -C "$ROOT" branch --show-current)" = main ] || die "the checkout is not on main; leave it for the user"
    [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes; leave it for the user"
    before=$(git -C "$ROOT" rev-parse HEAD)
    git -C "$ROOT" pull -q --ff-only origin main
    # build.sh only builds the Swift helpers when they are missing; rebuild one whose code changed.
    git -C "$ROOT" diff --quiet "$before" HEAD -- native/ears || sh "$ROOT/native/build-ears.sh"
    git -C "$ROOT" diff --quiet "$before" HEAD -- native/hands || sh "$ROOT/native/build-hands.sh"
    load_build_env
    (cd "$ROOT" && ./build.sh >/dev/null)
    echo "built JARVIS.app at $(git -C "$ROOT" log --oneline -1)"
    "$0" restart "an update: $(git -C "$ROOT" log --format=%s -1)"
    ;;
  restart)
    reason=$(printf '%s' "${*:-maintenance}" | tr -d '"\\' | cut -c1-200)
    printf '{"reason":"%s","at":"%s"}\n' "$reason" "$(date +%Y-%m-%dT%H:%M:%S)" > "$STATE/restart-request.json"
    echo "JARVIS will restart as soon as it is idle"
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    [ -z "$cmd" ] || exit 2
    ;;
esac
