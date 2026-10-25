#!/bin/sh
# Claude Code hook command: appends the hook's JSON (from stdin) plus the event
# name to ~/.jarvis/events.jsonl so JARVIS can react (permission prompts, session
# finished). Installed into ~/.claude/settings.json by install-hooks.sh.
event="${1:-unknown}"
mkdir -p "$HOME/.jarvis"
/usr/bin/python3 -I -c '
import json, sys, time
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
data["jarvis_event"] = sys.argv[1]
data["jarvis_ts"] = time.time()
# keep only what JARVIS needs; last_assistant_message can be long
for k in list(data.keys()):
    if k not in ("jarvis_event", "jarvis_ts", "session_id", "cwd", "hook_event_name", "message", "notification_type", "last_assistant_message", "transcript_path", "stop_hook_active"):
        del data[k]
if isinstance(data.get("last_assistant_message"), str):
    data["last_assistant_message"] = data["last_assistant_message"][-1500:]
sys.stdout.write(json.dumps(data) + "\n")
' "$event" >> "$HOME/.jarvis/events.jsonl" 2>/dev/null
exit 0
