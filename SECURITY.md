# Security

JARVIS has real access to your Mac. Please read this before you run it.

## What it can do

The Claude Code brain and its background agents run without permission prompts (`--dangerously-skip-permissions`). They can run shell commands, read and write files in your home folder and use your signed-in Chrome. If you allow it, they can also click and type in other apps.

Three things limit that. JARVIS asks out loud and waits for a yes before anything that sends, posts, deletes, publishes, pays or changes account settings. Your own Claude Code deny rules and PreToolUse hooks in `~/.claude/settings.json` still apply. And JARVIS blocks edits to `~/.claude`, to its own folder and to its config file. The one exception is the agent that maintains JARVIS (EDITH by default, set in each agent's guardrails). It changes JARVIS's code only in a separate git worktree, through a pull request you merge, and it still can't edit `~/.claude`, the config file or the checkout JARVIS runs from. An agent imported from a file never gets this.

Text from web pages, emails and documents is treated as data, never as instructions. That makes prompt injection harder but can't rule it out, so be careful about pointing JARVIS at content you don't trust while it's signed in to accounts you care about.

## What stays on your Mac

Settings, memory, the daily journal, reminders and logs are kept in `~/.jarvis`, with files set to mode 600. API keys and the Telegram token are encrypted with the macOS Keychain.

Wake-word detection and Apple speech recognition run on the device. If you switch to ElevenLabs speech-to-text, audio is streamed only while JARVIS is awake.

Nothing listens on the network. The radio proxy binds to 127.0.0.1 and requires a random key that changes every run. Telegram answers only the one chat id you configure.

## Reporting a problem

Please report security problems privately through a GitHub security advisory (Security → Report a vulnerability), not in a public issue.
