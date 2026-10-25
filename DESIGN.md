# Design

JARVIS is something you mostly listen to. The HUD is there to glance at, so the voice gets most of the design attention.

## The voice

The personality is defined in `prompts/system.md`; keep changes in line with it.

JARVIS is a calm British butler with a dry sense of humour, loosely modelled on Tony Stark's JARVIS. It's on the user's side, gets on with the job, admits when something fails and suggests the next step when that helps.

It talks like someone in the room. Sentences are short and use contractions, and most replies are one or two sentences. Words are plain, each sentence carries one idea, and the result comes before the reason, roughly following ASD-STE100 Simplified Technical English. If a joke would make an answer less clear, the joke goes.

Whatever it reads (search results, web pages, emails, reports from background jobs) it retells in its own words. It never reads out sources, links, lists or someone else's phrasing. `util.clean()` and `cutSources()` enforce this in code as a backstop.

It doesn't talk about agents, workers, tools or models unless the user asks how it works.

The user shouldn't sit in silence wondering if it heard. It says a short sentence before any slow step, plays a filler line if nothing has been said after about 1.8 seconds, gives spoken progress while background jobs run, and answers "what's the status?" immediately.

It says "done" only when the result was checked. Otherwise it says the job is unverified or failed, in plain words.

It asks first before sending, posting, deleting, paying, typing into a project session or taking over the mouse.

## The HUD

The HUD is a holographic display with a Three.js reactor in the middle, small-caps monospace labels and thin lines. You should be able to read it from across the desk.

### Themes

There are five themes, each with a dark and a light variant. They're defined in `src/renderer/themes.css`, shared by the HUD and the Setup window, and applied with `data-theme` and `data-mode` on `<html>`.

| Theme | Feel | Dark accent |
|---|---|---|
| JARVIS | holographic blue | `#39c3ff` |
| Terminal | green phosphor CRT with scanlines | `#33ff66` |
| Neon | cyberpunk magenta | `#ff3dc8` |
| Stark | red and gold | `#ffb240` |
| Minimal | graphite, no glow | `#9a9ca3` |

Always use the tokens instead of raw colours:

| Token | Use |
|---|---|
| `--bg`, `--panel-bg`, `--pop-bg`, `--field-bg` | backgrounds and surfaces |
| `--cyan` / `--rgb` | the theme's accent. The name is historical; it holds whatever the current theme's accent is. |
| `--text`, `--muted`, `--faint`, `--bright` | the four text levels |
| `--amber`, `--green`, `--red`, `--grey` | states: thinking, listening, error, standby |
| `--line`, `--line2`, `--hair` | borders, made from the accent at different strengths |
| `--glow` | 0 to 1 multiplier for the neon glow; Minimal sets it to 0 |

### Rules

The state is always shown as a word as well as a colour. The label under the microphone reads IDLE, LISTENING, THINKING, SPEAKING or STANDBY.

Labels are small caps in `--mono` with wide letter spacing. Anything meant to be read properly, such as replies, memory facts and settings, uses `--font-ui`.

Settings apply as soon as they change. Each control in SETTINGS saves and applies the value at once, and main sends the saved value back, so the HUD never shows a setting that isn't in effect.

Demo mode (`index.html?demo=1`, with `&view=memory` and so on) fills the HUD with made-up data. Use it for screenshots instead of your own sessions.
