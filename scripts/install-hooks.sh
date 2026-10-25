#!/bin/sh
# Install (or remove) the JARVIS hooks in ~/.claude/settings.json:
#   Notification(permission_prompt) -> JARVIS reads the prompt aloud and can answer it
#   Stop                            -> JARVIS announces when a session it steered finishes
# The hook only appends a line to ~/.jarvis/events.jsonl; it never blocks Claude Code.
#   install-hooks.sh            install
#   install-hooks.sh --uninstall
here="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/python3 -I - "$HOME/.claude/settings.json" "$here/hook-event.sh" "${1:-}" <<'PY'
import json, os, sys
path, cmd, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        try: cfg = json.load(f)
        except ValueError: cfg = {}
hooks = cfg.setdefault("hooks", {})

def ours(entry):
    return any(cmd in (h.get("command") or "") for h in entry.get("hooks", []))

# remove any previous JARVIS entries
for ev in list(hooks.keys()):
    hooks[ev] = [e for e in hooks[ev] if not ours(e)]
    if not hooks[ev]:
        del hooks[ev]

if mode != "--uninstall":
    hooks.setdefault("Notification", []).append({
        "matcher": "permission_prompt",
        "hooks": [{"type": "command", "command": f"{cmd} Notification", "async": True}],
    })
    hooks.setdefault("Stop", []).append({
        "hooks": [{"type": "command", "command": f"{cmd} Stop", "async": True}],
    })
if not hooks:
    cfg.pop("hooks", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, path)
print(("removed" if mode == "--uninstall" else "installed") + " JARVIS hooks in " + path)
PY
