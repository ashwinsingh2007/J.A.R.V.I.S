#!/bin/sh
# Claude Code sessions on this Mac as JSON, newest first: transcript-based
# (project, status, last message) merged with the iTerm tab that hosts it.
here="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/python3 -I - "$HOME/.claude/projects" "$here/terminals.sh" <<'PY'
import json, os, subprocess, sys, time
root, terminals_sh = sys.argv[1], sys.argv[2]
now = time.time()
try:
    brain_ids = set(open(os.path.expanduser("~/.jarvis/brain-sessions.txt")).read().split())
except OSError:
    brain_ids = set()

try:
    terms = json.loads(subprocess.run([terminals_sh], capture_output=True, text=True, timeout=15).stdout or "[]")
except Exception:
    terms = []
by_cwd = {t["cwd"]: t for t in terms if t.get("cwd")}

out = []
for d in os.listdir(root):
    dp = os.path.join(root, d)
    if not os.path.isdir(dp):
        continue
    for f in os.listdir(dp):
        if not f.endswith(".jsonl") or f[:-6] in brain_ids:
            continue
        fp = os.path.join(dp, f)
        try:
            mod = os.path.getmtime(fp)
        except OSError:
            continue
        if now - mod > 86400:
            continue
        cwd, last, brain = "", "", False
        try:
            with open(fp, "rb") as h:
                h.seek(0, 2); size = h.tell()
                h.seek(max(0, size - 96 * 1024))
                lines = h.read().decode("utf-8", "ignore").split("\n")
        except OSError:
            continue
        for line in reversed(lines):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not cwd and isinstance(o.get("cwd"), str):
                cwd = o["cwd"]
            m = o.get("message") or {}
            if o.get("type") == "user" and isinstance(m.get("content"), str) and "JARVIS_BRAIN_MARKER" in m["content"]:
                brain = True
            if not last and o.get("type") == "assistant":
                for b in m.get("content") or []:
                    if b.get("type") == "text" and b.get("text"):
                        last = b["text"].replace("\n", " ")[:200]; break
                    if b.get("type") == "tool_use":
                        last = "using " + b.get("name", "tool"); break
            if cwd and last:
                break
        if brain:
            continue
        age = now - mod
        t = by_cwd.get(cwd)
        out.append({
            "project": os.path.basename(cwd) if cwd else d,
            "cwd": cwd or d,
            "status": "working" if age < 90 else ("idle" if age < 1800 else "done"),
            "minutes_ago": int(age // 60),
            "last": last,
            "terminal": ({"title": t["title"], "tty": t["tty"], "state": t["state"]} if t else None),
            "session_id": f[:-6],
            "_m": mod,
        })
out.sort(key=lambda s: -s["_m"])
seen, dedup = set(), []
for s in out:
    del s["_m"]
    if s["cwd"] in seen:
        continue
    seen.add(s["cwd"]); dedup.append(s)
print(json.dumps({"sessions": dedup[:12], "terminals_without_transcript": [t for t in terms if t["claude"] and t["cwd"] not in seen]}, indent=1))
PY
