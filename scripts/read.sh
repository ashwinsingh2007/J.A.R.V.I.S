#!/bin/sh
# Print the last assistant messages from the newest Claude Code transcript
# whose project path contains the given name (or whose iTerm tab title matches).
[ -n "$1" ] || { echo "usage: read.sh <project-name-or-path> [count]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/python3 -I - "$HOME/.claude/projects" "$1" "${2:-4}" "$here/terminals.sh" <<'PY'
import json, os, subprocess, sys
root, needle, count, terminals_sh = sys.argv[1], sys.argv[2].lower(), int(sys.argv[3]), sys.argv[4]

# Tab title → cwd, so "read.sh nurture" works even if the folder is named differently.
cwd_hint = ""
try:
    for t in json.loads(subprocess.run([terminals_sh], capture_output=True, text=True, timeout=15).stdout or "[]"):
        if needle in t["title"].lower() or needle in t["cwd"].lower():
            cwd_hint = t["cwd"]; break
except Exception:
    pass

def slug(p): return p.replace("/", "-")
best = None
for d in os.listdir(root):
    if needle not in d.lower() and not (cwd_hint and d == slug(cwd_hint)):
        continue
    dp = os.path.join(root, d)
    for f in os.listdir(dp):
        if f.endswith(".jsonl"):
            fp = os.path.join(dp, f)
            m = os.path.getmtime(fp)
            if best is None or m > best[0]:
                best = (m, fp)
if not best:
    print("No session found for", needle); sys.exit(1)
msgs = []
with open(best[1], "rb") as h:
    h.seek(0, 2); size = h.tell(); h.seek(max(0, size - 300 * 1024))
    for line in h.read().decode("utf-8", "ignore").split("\n"):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("type") != "assistant":
            continue
        for b in (o.get("message") or {}).get("content") or []:
            if b.get("type") == "text" and b.get("text"):
                msgs.append(b["text"].strip())
print("Transcript:", best[1])
for m in msgs[-count:]:
    print("---"); print(m[:1500])
PY
