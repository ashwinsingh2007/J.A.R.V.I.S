#!/bin/sh
# JSON list of iTerm2 terminal tabs: tty, title, whether Claude Code runs there,
# its pid and working directory. Used to map "the fireflies session" to a tab.
exec /usr/bin/python3 -I - <<'PY'
import json, subprocess, re

APPLESCRIPT = '''
tell application "iTerm"
  set out to ""
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      repeat with s in sessions of t
        set out to out & wi & "\t" & ti & "\t" & (tty of s) & "\t" & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell
'''

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw).stdout

rows = run(["osascript", "-e", APPLESCRIPT]).strip().split("\n")
ps = run(["ps", "-axo", "pid=,tty=,comm="])
claude_by_tty = {}
for line in ps.splitlines():
    parts = line.split(None, 2)
    if len(parts) == 3 and parts[2].endswith("/claude") or (len(parts) == 3 and parts[2] == "claude"):
        claude_by_tty.setdefault(parts[1], parts[0])

def cwd_of(pid):
    out = run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"])
    for l in out.splitlines():
        if l.startswith("n"):
            return l[1:]
    return ""

terminals = []
for r in rows:
    if not r.strip():
        continue
    win, tab, tty, title = r.split("\t", 3)
    short = tty.replace("/dev/", "")
    pid = claude_by_tty.get(short)
    cwd = cwd_of(pid) if pid else ""
    glyph = title[:1]
    state = {"◐": "working", "✳": "idle", "⠂": "working"}.get(glyph, "unknown" if pid else "no-claude")
    terminals.append({
        "window": int(win), "tab": int(tab), "tty": short, "title": title.strip(),
        "claude": bool(pid), "pid": int(pid) if pid else None, "cwd": cwd,
        "project": cwd.rsplit("/", 1)[-1] if cwd else "", "state": state,
    })
print(json.dumps(terminals, indent=1))
PY
