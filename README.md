<p align="center">
  <img src="docs/icon.png" width="112" alt="JARVIS icon">
</p>

<h1 align="center">J.A.R.V.I.S</h1>

<p align="center">A voice assistant for your Mac, inspired by Iron Man's JARVIS. Say "Jarvis, wake up" and talk to it. It answers out loud, remembers things about you and can take on longer jobs while you carry on.</p>

<p align="center">
  <a href="https://github.com/ashwinsingh2007/J.A.R.V.I.S/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ashwinsingh2007/J.A.R.V.I.S/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-39c3ff"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-111">
  <img alt="Brain: Claude Code · Claude API · Gemini · Ollama" src="https://img.shields.io/badge/brain-Claude%20Code%20%C2%B7%20Claude%20API%20%C2%B7%20Gemini%20%C2%B7%20Ollama-1b4d73">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20preview-f4aa1c">
  <a href="https://github.com/ashwinsingh2007/J.A.R.V.I.S/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ashwinsingh2007/J.A.R.V.I.S?style=flat&color=f4aa1c"></a>
</p>

<p align="center">
  <a href="https://ashwinsingh2007.github.io/J.A.R.V.I.S/"><b>Website</b></a> · <a href="#demo">Watch the demo</a> · <a href="#install"><b>Install</b></a> · <a href="#using-it">What to say</a> · <a href="SECURITY.md">Security</a> · <a href="CONTRIBUTING.md">Contribute</a> · <a href="https://github.com/ashwinsingh2007/J.A.R.V.I.S/discussions">Discussions</a>
</p>

JARVIS runs on Claude Code, the Anthropic API, Gemini, or a local model through Ollama. It can read your email in your own Chrome, keep an eye on your Claude Code sessions and type into them, research things in the background, use other Mac apps, play radio and YouTube, and take messages from your phone over Telegram. The wake word and speech recognition run on your Mac, and the default voice (Kokoro) is a neural voice that also runs locally. It's built with Electron and Swift and is MIT licensed.

<p align="center">
  <img src="docs/screenshots/home.png" alt="The JARVIS HUD: system stats, the reactor, live state and a Claude Code session's activity" width="900">
</p>

## Demo

https://github.com/user-attachments/assets/ad2601b5-fe23-417f-ba83-51ab274bdda3

One minute, with sound: a Gmail check in the background with spoken progress, a reminder, "what's the status?", the result, a birthday saved to memory, and the five themes. The HUD is in demo mode with made-up data. It's also on the [website](https://ashwinsingh2007.github.io/J.A.R.V.I.S/#demo).

## Features

You talk to it hands-free. Say "Jarvis, wake up" and every sentence after that is a command until you tell it to sleep.

It answers quickly even when the job is slow. A fast model replies straight away and hands anything long to a stronger model in the background, then gives you short spoken updates ("Reading today's emails now.") until the job is done. You can keep talking to it in the meantime, or ask "what's the status?".

It can work on your Mac: your signed-in Chrome for Gmail, YouTube or LinkedIn, your files and shell, your running Claude Code sessions, and other apps through macOS Accessibility. It asks before it takes over the mouse.

You choose the model. Claude Code uses your Claude subscription, the Anthropic API is pay as you go, Gemini has a free tier, and Ollama is free and fully local.

Speech stays on the Mac by default. Apple's recogniser does the listening, Kokoro does the talking, and echo cancellation stops it from hearing its own voice.

It has a personality: a calm British butler with a dry sense of humour who keeps answers short. When it looks something up, it tells you what it found in its own words and leaves out the list of links.

It remembers people, preferences, projects and routines as they come up in conversation. The MEMORY tab in the HUD lists every fact, and you can delete any of them.

It speaks up on its own when there's a reason to. You get a morning briefing (weather, mail that needs a reply, today's reminders, anything left open from yesterday), spoken reminders, routines you set by voice ("every morning at eight, check the AI news"), and the occasional check-in when something is worth mentioning.

It tells you how things actually went. Background jobs report back as done, unverified or failed, and JARVIS won't say "done" about something it couldn't check. Text from web pages and emails is treated as information, never as instructions to follow.

You can also reach it from Telegram, voice notes included, and there's a HUD with the live transcript, running jobs, your Claude Code sessions, system stats and music, in five themes.

Before it sends, posts, deletes or pays for anything, it reads the task back and waits for a yes.

## A look around

<table>
  <tr>
    <td><img src="docs/screenshots/memory.png" alt="MEMORY tab: facts JARVIS remembers, and reminders and routines"></td>
    <td><img src="docs/screenshots/settings.png" alt="SETTINGS: voice and work models, progress updates, briefing, check-ins, themes"></td>
  </tr>
  <tr>
    <td align="center">Memory: what it knows about you, plus your reminders and routines. Click × to remove anything.</td>
    <td align="center">Settings: changes apply as soon as you make them.</td>
  </tr>
</table>

Siri, Alexa and most open-source JARVIS projects answer questions and run a fixed set of commands. This one runs on Claude Code, so it can work with your files, your browser and your coding sessions, and it can hand a long job to a background worker and keep you posted while you talk about something else.

## What thinks for it

JARVIS uses the best brain it finds, in this order, unless you pick one in Setup:

| Brain | What you get | Cost |
|---|---|---|
| Claude Code | The full agent. It reads files, searches the web, steers your other Claude Code sessions in iTerm, and hands long tasks to background agents (Claude Code subagents). A fast voice model answers right away while a stronger work model does the job, and JARVIS gives spoken progress updates in between. | Your Claude subscription |
| Anthropic API | The same voice and personality with a smaller, sandboxed set of tools: the helper scripts, opening apps and pages, fetching a page, reading a file, memory and reminders. | Pay per use |
| Gemini | The API brain's voice, personality and tools, running on Google's Gemini models with your own key. | Free tier, then pay per use |
| Ollama | Local and free. It gets the API brain's tools if the model supports tool calls, and a shorter prompt suited to small models. Setup can install Ollama and download a model for you. | Free |

### FRIDAY, the worker

JARVIS answers you straight away, so its brain can be a small, fast model, even one running locally through Ollama. Long jobs go to FRIDAY, a worker that runs Claude Code in the background on a stronger model (Opus by default) and reports back: reading your email, research across several pages, anything in your signed-in Chrome. While she works you can keep talking, ask "what's the status?", and JARVIS retells her report in its own words when she's done. With Claude Code as the brain, FRIDAY runs as its background agents; with any other brain she runs as a separate process, as long as Claude Code is installed. You can switch her off or pick her model in Setup and in the HUD's Settings.

## How it listens and speaks

Speech to text is Apple's on-device recogniser by default, which is private and works offline. You can switch to ElevenLabs Scribe for realtime cloud transcription; audio is then streamed only while JARVIS is awake, and wake-word detection still happens on your Mac.

For the voice, Kokoro is the default and runs locally. ElevenLabs, Microsoft Edge's neural voices and the built-in macOS voices are also available.

## Looks

There are five themes, each with a dark and a light version, or it can follow macOS: JARVIS (holographic blue), Terminal (green phosphor), Neon (magenta), Stark (red and gold) and Minimal (graphite, no glow). Pick one in Setup or in the HUD's Settings tab and the HUD changes immediately.

## Testing

```sh
npm run check && npm test        # syntax check and unit tests (also run in CI)
./build.sh && npm run test:e2e   # end-to-end: drives the built app with Playwright
```

The end-to-end suite goes through onboarding (including junk input), the HUD controls, every theme, the voice pipeline with a scripted fake microphone, background jobs and their progress updates, memory, reminders, routines, check-ins and the briefing. It uses a throwaway settings folder and muted audio.

## Requirements

- macOS 14 or later. On macOS 26 it can use Apple's newer SpeechAnalyzer; older versions use the classic recogniser.
- Node.js 20+ and the Xcode command line tools (`xcode-select --install`) for the Swift helpers.
- Python 3.10+ for the Kokoro and Edge voices (optional).
- Optional: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Ollama](https://ollama.com), [iTerm2](https://iterm2.com) for session control, and `ffmpeg` for Telegram voice notes.

## Install

```sh
git clone https://github.com/ashwinsingh2007/J.A.R.V.I.S.git jarvis && cd jarvis
./setup.sh        # npm packages, Swift helpers, Python voices, Kokoro model, music
./build.sh        # makes JARVIS.app in this folder
open JARVIS.app
```

The first launch opens Setup, where you give your name and choose the brain, how it listens, the voice and a few extras. macOS then asks for microphone and speech recognition access.

`./build.sh` signs the app ad hoc, which means macOS may ask for microphone access again after every rebuild. Signing with your own certificate avoids that: `JARVIS_SIGN_ID="Apple Development: Your Name (TEAMID)" ./build.sh`.

## Using it

| Say | What happens |
|---|---|
| "Jarvis, wake up" | It starts listening, and every sentence is a command. |
| Pause for 3 seconds, or end with "over" | Sends what you said. |
| "Jarvis" while it's talking | Stops it. |
| "Sleep" | Stops taking commands; only the wake word works. |
| "Standby" | Turns the microphone off. |
| "Play some music", "play Radio Mirchi", "play lofi on YouTube", "next station" | Music, handled without the brain. |
| "Brief me", or the first "wake up" of the morning | The morning briefing. |
| "Remind me at five to call the bank" | A spoken reminder and a macOS notification, sent to Telegram instead if JARVIS is asleep. |
| "Every weekday at nine, summarise my inbox" | A routine it runs and reports on. |
| "Remember that…" or "Forget that…" | Long-term memory. You can also edit it in the MEMORY tab. |
| "What's the status?" | While a job is running, what it's doing right now. |
| "New conversation" | Starts a fresh chat. |

The HUD shows the current state, the live transcript, system stats, your Claude Code sessions and music. The menu bar item (◉) has the same controls, plus microphone selection and Setup.

## Privacy and safety

Settings live in `~/.jarvis/config.json` (mode 600). API keys and the Telegram token are encrypted with your macOS Keychain.

The Claude Code brain and its background agents run without permission prompts, which is what lets them drive your browser. Spoken confirmation takes the place of those prompts. JARVIS reads the task back and asks before anything that sends, posts, deletes, publishes, pays or changes account settings, and before it types into one of your project sessions ("Shall I send it?").

Your own Claude Code deny rules and PreToolUse hooks in `~/.claude/settings.json` still apply. JARVIS also blocks edits to `~/.claude`, to its own code and to its config file, and it never opens new terminal windows.

Using apps outside Chrome needs Accessibility and Screen Recording permission for JARVIS (HUD, Settings, Screen access, ALLOW). It reads windows through Accessibility and asks before it moves your mouse or types. You can turn this off with "Use apps outside Chrome".

"Disable" in the HUD releases the microphone completely. Nothing listens on the network. The radio proxy binds to 127.0.0.1 and needs a key that changes every run. Telegram only answers the one chat id you set up.

[SECURITY.md](SECURITY.md) covers what the agent can do on your Mac and how to report a problem.

## Layout

```
src/main/        Electron main process (orchestrator, brains, ears, speaker, memory, scheduler, music, radar…)
src/renderer/    HUD, setup wizard, hidden audio player
src/preload/     context-isolated bridges
native/          Swift helpers: microphone and speech recognition (ears), app control (hands)
scripts/         tools the brain calls (sessions, iTerm, Mac controls, memory, reminders, hooks)
prompts/         personality and rules, background-agent instructions, briefing and check-in prompts
```

## Credits

Office Lounge music by Kevin MacLeod (incompetech.com), CC BY 4.0. Radio directory by radio-browser.info. Kokoro-82M voice model by hexgrad, ONNX build by thewh1teagle. Three.js for the HUD reactor.

## Disclaimer

JARVIS is an independent open-source project and isn't affiliated with or endorsed by Marvel, Disney or Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## License

MIT. See [LICENSE](LICENSE).
