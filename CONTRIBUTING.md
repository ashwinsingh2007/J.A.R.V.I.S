# Contributing to JARVIS

Thanks for helping. Bug reports, fixes, new skills, better wording and new voices are all welcome.

## Keep personal data out

JARVIS hears your voice, reads your sessions and remembers facts about you, so please be careful with what you share:

- Never paste your `~/.jarvis` folder, `memory.json`, journal files, `config.json` or logs into an issue without reading them first. Remove names, emails, keys and anything else personal.
- Screenshots should come from the HUD's demo mode, not your own sessions: open `src/renderer/hud/index.html?demo=1` in a browser (add `&view=memory`, `&view=settings` and so on).
- To try changes without touching your real setup, run a copy with its own settings folder:

  ```bash
  JARVIS_STATE_DIR=/tmp/jarvis-dev npm start
  ```

## Setting up

You need macOS 14 or later, Node.js 20+, Xcode command line tools, and optionally Python 3.10+ (for the Kokoro and Edge voices) and [Claude Code](https://docs.claude.com/en/docs/claude-code).

```bash
git clone https://github.com/ashwinsingh2007/jarvis-voice-assistant.git jarvis
cd jarvis
./setup.sh      # npm packages, Swift helpers, Python voices, Kokoro model
npm start       # run from source
./build.sh      # or package JARVIS.app
```

The README explains how the pieces fit together. Design rules for the HUD and for how JARVIS talks are in [DESIGN.md](DESIGN.md).

## Where things live

| Folder | What it is |
|---|---|
| `src/main/` | Electron main process: orchestrator, brains, ears, speaker, memory, scheduler, music, session radar |
| `src/renderer/` | HUD, setup wizard, hidden audio player |
| `native/` | Swift helpers: microphone and speech recognition (`ears`), app control through Accessibility (`hands`) |
| `scripts/` | Shell and Python tools the brain calls (sessions, iTerm, Mac controls, memory, reminders) |
| `prompts/` | JARVIS's personality and rules, the background-agent instructions, the briefing and check-in prompts |
| `test/` | Unit tests (`test/unit`) and the end-to-end suite (`test/e2e.mjs`) |

## Before you open a pull request

Run the same checks as CI:

```bash
npm run check && npm test
```

If you changed anything the user hears or sees, also run the end-to-end suite. It drives the packaged app with a scripted fake microphone and muted audio, in a throwaway settings folder:

```bash
./build.sh && npm run test:e2e          # or one suite: node test/e2e.mjs voice
```

Then:

- Keep each pull request to one change. Small ones get reviewed faster.
- Add or update a unit test for logic in `src/main` (parsing, scheduling, memory, text cleaning).
- Prompt changes matter as much as code. If you edit `prompts/`, describe what JARVIS said before and after.
- Never weaken a safety rule: spoken confirmation before sending, posting, deleting or paying; the untrusted-content guard; the deny rules for JARVIS's own files.
- If your change sends any new data off the Mac, say so in the pull request and update the privacy section of the README and SECURITY.md.

For a large change, such as a new brain, a new skill area or a new HUD page, open an issue first so we can agree on the approach.

## Commit messages

Write the subject in the imperative ("Add Spotify skill", not "Added…"), keep it under about 70 characters, and use the body to explain why.

## Licence

JARVIS is MIT licensed. By opening a pull request you agree that your contribution is released under the same licence.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
