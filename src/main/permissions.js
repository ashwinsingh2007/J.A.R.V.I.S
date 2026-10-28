// The macOS permissions JARVIS uses, for the Setup and Settings permission lists: check each one,
// and ask for it (show the system dialog, or open the right System Settings pane when it was denied).
const fs = require('fs');
const path = require('path');
const { run, paths } = require('./util');

const PANES = {
  mic: 'Privacy_Microphone',
  speech: 'Privacy_SpeechRecognition',
  ax: 'Privacy_Accessibility',
  screen: 'Privacy_ScreenCapture',
  iterm: 'Privacy_Automation',
};

/**
 * "allowed" | "not-asked" | "denied" | "unknown" for each, plus "absent" for iTerm when it isn't installed,
 * and "no-helper" for the microphone and speech when the speech helper isn't built (it needs macOS 14).
 */
async function state(earsBin) {
  const out = { mic: 'unknown', speech: 'unknown', ax: 'unknown', screen: 'unknown', iterm: 'absent' };
  if (!earsBin || !fs.existsSync(earsBin)) {
    out.mic = out.speech = 'no-helper';
  } else {
    const r = await run(earsBin, ['--permissions'], { timeout: 10000 });
    try { Object.assign(out, JSON.parse(r.out.trim().split('\n').pop())); } catch {}
  }
  const hands = path.join(paths.root, 'resources', 'jarvis-hands');
  if (fs.existsSync(hands)) {
    const r = await run(hands, ['check'], { timeout: 10000 });
    out.ax = /accessibility: yes/.test(r.out) ? 'allowed' : 'not-asked';
    out.screen = /screen recording: yes/.test(r.out) ? 'allowed' : 'not-asked';
  }
  if (fs.existsSync('/Applications/iTerm.app')) out.iterm = await itermState(false);
  return out;
}

/** Apple Events to iTerm. Asking only when iTerm is running avoids starting it just to check. */
async function itermState(ask) {
  const running = /true/.test((await run('/usr/bin/osascript', ['-e', 'application id "com.googlecode.iterm2" is running'], { timeout: 5000 })).out);
  if (!running && !ask) return 'unknown';
  const r = await run('/usr/bin/osascript', ['-e', 'tell application id "com.googlecode.iterm2" to get version'], { timeout: 60000 });
  if (r.code === 0) return 'allowed';
  return /-1743|not allowed|Not authorized/i.test(r.err) ? 'denied' : 'unknown';
}

/**
 * Ask for one permission. macOS only shows its dialog the first time; after a "Don't Allow" the
 * only way back is System Settings, so that pane is opened instead.
 */
async function ask(which, { earsBin, openPane, notify }) {
  if (which === 'mic' || which === 'speech') {
    // Only the speech helper can ask macOS for these, so without it there is nothing to show.
    const before = await state(earsBin);
    if (before[which] === 'no-helper') return before;
    if (before[which] === 'denied') { openPane(PANES[which]); return state(earsBin); }
    await run(earsBin, ['--permissions', '--prompt'], { timeout: 120000 });
  } else if (which === 'ax' || which === 'screen') {
    const hands = path.join(paths.root, 'resources', 'jarvis-hands');
    await run(hands, ['check', '--prompt'], { timeout: 15000 });
    const now = await state(earsBin);
    if (now[which] !== 'allowed') openPane(PANES[which]);
    return now;
  } else if (which === 'iterm') {
    if ((await itermState(true)) === 'denied') openPane(PANES.iterm);
  } else if (which === 'notifications') {
    notify('JARVIS', 'Reminders will show up here.');
  }
  return state(earsBin);
}

module.exports = { state, ask, PANES };
