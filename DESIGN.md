# Design

JARVIS has two faces: the voice you hear and the HUD you glance at. The voice matters more, because most of the time the user isn't looking at the screen.

## The voice

The personality lives in `prompts/system.md`. Keep changes consistent with it.

- **Who:** a loyal, calm British butler with dry wit, in the spirit of Tony Stark's JARVIS. On the user's side, quietly competent, honest when something fails, and a step ahead when it helps.
- **How it talks:** like a person in the room. Short natural sentences with contractions, usually one or two. Plain words, one idea per sentence, the result first, in the spirit of ASD-STE100 Simplified Technical English. Clarity beats wit every time.
- **It digests, never reads out.** Search results, pages, emails and background reports are retold in its own words. No sources, links, lists or someone else's wording, ever. `util.clean()` and `cutSources()` back this up in code.
- **It hides the machinery.** No "agents", "workers", "tools" or "models" unless the user asks how it works.
- **It never leaves the user in silence.** A quick sentence before any slow step, a filler after about 1.8 s, spoken progress while background jobs run, and an instant answer to "what's the status?".
- **It's honest about results.** "Done" only when checked. Otherwise "unverified" or "failed", in plain words.
- **It asks before acting on the world:** sending, posting, deleting, paying, typing into a project session, or taking over the mouse.

## The HUD

A holographic heads-up display: a Three.js reactor in the middle, small-caps monospace labels, thin lines, no heavy chrome. It should read in one glance from across the desk.

### Themes

Five themes, each in dark and light, defined in `src/renderer/themes.css` and shared by the HUD and the Setup window. They are applied with `data-theme` and `data-mode` on `<html>`.

| Theme | Feel | Dark accent |
|---|---|---|
| JARVIS | holographic blue | `#39c3ff` |
| Terminal | green phosphor CRT, scanlines | `#33ff66` |
| Neon | cyberpunk magenta | `#ff3dc8` |
| Stark | red and gold | `#ffb240` |
| Minimal | graphite, no glow | `#9a9ca3` |

Use the tokens, never raw colours:

| Token | Use |
|---|---|
| `--bg`, `--panel-bg`, `--pop-bg`, `--field-bg` | backgrounds and surfaces |
| `--cyan` / `--rgb` | the theme's accent (named "cyan" for history; it is whatever the theme's accent is) |
| `--text`, `--muted`, `--faint`, `--bright` | four text levels |
| `--amber`, `--green`, `--red`, `--grey` | states: thinking, listening, error, standby |
| `--line`, `--line2`, `--hair` | borders, from the accent at different strengths |
| `--glow` | 0 to 1 multiplier for neon glow; Minimal sets it to 0 |

### Rules

- **State is colour plus a word.** The state label under the microphone always says IDLE, LISTENING, THINKING, SPEAKING or STANDBY, so colour is never the only signal.
- **Labels** are small caps in `--mono` with wide letter spacing. **Readable text** (replies, memory facts, settings) uses `--font-ui`.
- **Settings apply live.** Every control in SETTINGS saves and applies at once, and the saved value is echoed back, so the HUD never shows a setting that isn't real.
- **Demo mode** (`index.html?demo=1`, plus `&view=memory` and so on) fills the HUD with made-up data. Use it for screenshots, never your own sessions.
