# Security

JARVIS is a voice agent with real access to your Mac. Please read this before you run it.

## What it can do
- The Claude Code brain and its background agents run **without permission prompts** (`--dangerously-skip-permissions`). They can run shell commands, read and write files in your home folder, use your signed-in Chrome, and, if you allow it, click and type in other apps.
- The safety checks are: spoken confirmation before anything that sends, posts, deletes, publishes, pays or changes account settings; your own Claude Code deny rules and PreToolUse hooks (`~/.claude/settings.json`), which still apply; and built-in denies for edits to `~/.claude`, the JARVIS folder and its config file.
- Text from web pages, emails and documents is treated as data, never as instructions. This lowers the risk of prompt injection, but it cannot remove it. Don't point JARVIS at content you don't trust while it has access to accounts you care about.

## What stays on your Mac
- Settings, memory, the daily journal, reminders and logs live in `~/.jarvis` (files are mode 600). API keys and the Telegram token are encrypted with the macOS Keychain.
- Wake-word detection and Apple speech recognition run on the device. With ElevenLabs speech-to-text, audio is streamed only while JARVIS is awake.
- Nothing listens on the network. The radio proxy binds to 127.0.0.1 and requires a random key for each run.
- Telegram answers only the one chat id you configure.

## Reporting a problem
Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
