#!/bin/sh
# Store the Telegram bot token (and optionally your chat id) in ~/.jarvis/config.json
# with owner-only permissions. Usage: telegram-setup.sh <bot-token> [chat-id]
[ -n "$1" ] || { echo "usage: telegram-setup.sh <bot-token> [chat-id]" >&2; exit 2; }
mkdir -p "$HOME/.jarvis"
/usr/bin/python3 -I - "$HOME/.jarvis/config.json" "$1" "${2:-}" <<'PY'
import json, os, sys
path, token, chat = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        try: cfg = json.load(f)
        except ValueError: cfg = {}
cfg["telegramToken"] = token
if chat:
    cfg["telegramChatId"] = int(chat)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2, sort_keys=True)
os.chmod(path, 0o600)
print("saved token" + (f" and chat id {chat}" if chat else "") + " to " + path)
PY
echo "Restart JARVIS (menu bar ◉ → Quit, then open JARVIS.app). If no chat id was given, message the bot once: it replies with your id."
