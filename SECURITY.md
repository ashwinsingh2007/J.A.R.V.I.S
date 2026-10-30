# Security

JARVIS has real access to your Mac. Please read this before you run it.

## What it can do

The Claude Code brain and its background agents run without permission prompts (`--dangerously-skip-permissions`). They can run shell commands, read and write files in your home folder and use your signed-in Chrome. If you allow it, they can also click and type in other apps.

Three things limit that. JARVIS asks out loud and waits for a yes before anything that sends, posts, deletes, publishes, pays or changes account settings. Your own Claude Code deny rules and PreToolUse hooks in `~/.claude/settings.json` still apply. And JARVIS blocks edits to `~/.claude`, to its own folder and to its config file. The one exception is the agent that maintains JARVIS (EDITH by default, set in each agent's guardrails). It changes JARVIS's code only in a separate git worktree, through a pull request you merge, and it still can't edit `~/.claude`, the config file or the checkout JARVIS runs from. An agent imported from a file never gets this.

Text from web pages, emails and documents is treated as data, never as instructions. That makes prompt injection harder but can't rule it out, so be careful about pointing JARVIS at content you don't trust while it's signed in to accounts you care about.

## What stays on your Mac

Settings, memory, the daily journal, reminders and logs are kept in `~/.jarvis`, with files set to mode 600. API keys and the Telegram token are encrypted with the macOS Keychain.

Wake-word detection and Apple speech recognition run on the device. If you switch to ElevenLabs speech-to-text, audio is streamed only while JARVIS is awake.

Nothing listens on a fixed port. The radio proxy binds to 127.0.0.1 and requires a random key that changes every run. Telegram answers only the one chat id you configure. The brain's helper and the `jarvis` terminal command reach JARVIS through a socket in `~/.jarvis` that only your user can open. Because the command types to JARVIS as you, JARVIS's own brain and workers are not allowed to run it: their deny rules block it, and the command refuses to run inside a JARVIS process.

Other devices (Settings › Devices) are off until you pair one. Once paired, JARVIS joins the Hyperswarm peer-to-peer network as a light, ephemeral member: it looks up only its own pairs and never routes lookups for others. It uses a UDP socket on a random port, and connections are refused at the encrypted handshake unless they come from a paired device's key. Pairing uses an 8-character code, stretched with scrypt, that both sides prove they hold without sending it. It works for three minutes. When a direct connection isn't possible, messages go through an ntfy relay (ntfy.sh unless you set your own). They are encrypted with AES-256-GCM using a key only your two devices share, and name which device sent them and to whom, which the key authenticates. Each carries a timestamp and an ID so that replays are dropped. The relay can see that two addresses exchange messages, and when, but not what they say. A task from another device runs as a background job with the same confirmation rule: sending, posting, deleting or paying needs your yes on the device you asked from.

## Reporting a problem

Please report security problems privately through a GitHub security advisory (Security → Report a vulnerability), not in a public issue.
