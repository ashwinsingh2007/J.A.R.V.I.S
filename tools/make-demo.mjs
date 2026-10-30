// Records the demo video: a scripted conversation played through the HUD's
// demo mode, with JARVIS speaking in the Kokoro voice and the user in a macOS
// voice. Writes docs/demo/jarvis-demo.mp4 (with sound) and a poster frame.
//
//   node tools/make-demo.mjs [theme]   (needs ./setup.sh done, Google Chrome and ffmpeg; Stark by default)
import { chromium } from 'playwright';
import { assistantsEvent } from './demo-data.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'demo');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-demo-'));
const USER_VOICE = 'Aman (English (India))';
const W = 1440, H = 900;
const THEME = process.argv[2] || 'stark';
// In the page: click something (an HTML element or one of the SVG nodes around the core).
const click = (sel) => ({ js: `document.querySelector(${JSON.stringify(sel)}).click()` });
const node = (label) => ({ js: `[...document.querySelectorAll('#crew .mate')].find((m) => m.textContent.includes(${JSON.stringify(label)})).dispatchEvent(new MouseEvent('click', { bubbles: true }))` });

const now = new Date();
const at = (h, m, d = 0) => { const x = new Date(now); x.setDate(x.getDate() + d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(h)}:${p(m)}`; };
const FACTS = [
  { id: 'm1', text: 'Prefers lo-fi music while working.', topic: 'preference', added: '2026-10-21T09:12' },
  { id: 'm2', text: 'Lives in Bengaluru and works from home on Fridays.', topic: 'place', added: '2026-10-22T18:40' },
  { id: 'm4', text: '"The web app" means the project in ~/Projects/web-app.', topic: 'project', added: '2026-10-24T11:30' },
  { id: 'm5', text: 'Goes for a run most mornings around seven.', topic: 'routine', added: '2026-10-24T07:55' },
];
const SCHEDULE = [
  { id: 'r2', kind: 'task', text: 'Check the AI news and tell me only what is new.', due: at(8, 0, 1), repeat: 'daily' },
  { id: 'r3', kind: 'task', text: 'Summarise my inbox and tell me what needs a reply.', due: at(9, 0, 1), repeat: 'weekdays' },
];
const bank = { id: 'r1', kind: 'reminder', text: 'Call the bank.', due: at(17, 0), repeat: null };
const priya = { id: 'm6', text: "Sister Priya's birthday is on 14 November.", topic: 'person', added: at(now.getHours(), now.getMinutes()) };
const gift = { id: 'r4', kind: 'reminder', text: 'Order a birthday gift for Priya.', due: '2026-11-11T10:00', repeat: null };

// The conversation. `do` runs in the page when the line (or pause) starts: HUD events, or { js } to run.
const SCRIPT = [
  { you: 'Jarvis, wake up.' },
  { jarvis: 'Yes, sir?', do: [{ type: 'mode', conversation: true }] },
  { you: 'Check my Gmail and tell me what needs a reply.' },
  { jarvis: "Opening your inbox now, sir. I'll tell you what I find.", do: [{ type: 'stats', agents: ['checking your Gmail'] }, { type: 'notice', text: 'Working: checking your Gmail' }] },
  { pause: 1400, do: [{ type: 'notice', text: 'Your inbox is open. Reading the emails from today.' }] },
  { you: 'Also, remind me at five to call the bank.' },
  { jarvis: "Done. I'll remind you at five.", do: [{ type: 'schedule', data: [bank, ...SCHEDULE] }] },
  { you: 'How many agents do you have?' },
  { jarvis: 'Five, sir. FRIDAY for code, KAREN for your messages, EDITH looks after me, and VISION for research.', do: [{ js: "document.body.classList.add('focus')" }] },
  { pause: 600, do: [{ js: "document.body.classList.remove('focus')" }] },
  { you: 'Let me talk to FRIDAY.' },
  { pause: 1400, do: [node('FRIDAY'), { js: "setTimeout(() => window.hud.event({ type: 'assistant', id: 'friday' }), 900)" }] },
  { jarvis: 'FRIDAY here. Ready when you are.', voice: 'bf_emma' },
  { you: 'Show me all the agents.' },
  { jarvis: "Here's everyone, with our roles, brains, voices and guardrails.", voice: 'bf_emma', view: 'agents', do: [{ js: "setTimeout(() => document.querySelector('#acards .agcard[data-id=\"edith\"]').click(), 2200)" }] },
  { pause: 1800 },
  { you: 'Back to JARVIS, please.' },
  { pause: 300, do: [{ js: "document.querySelector('#nav a[data-view=\"cc\"]').click()" }, { js: "setTimeout(() => window.hud.event({ type: 'assistant', id: 'jarvis' }), 700)" }] },
  { pause: 1200 },
  { jarvis: 'At your service, sir.' },
  { you: 'Which computers are connected?' },
  { jarvis: 'The Home Mac, sir, on the local network. FRIDAY is working there on the payments module.', do: [node('MESH')] },
  { you: 'Show me the Home Mac.' },
  { jarvis: 'Here it is, sir. The refactor is halfway, and most of the tests already pass.', do: [click('#machine-pick'), { js: "setTimeout(() => document.querySelector('.mtab[data-device=\"home\"]').click(), 500)" }] },
  { pause: 2600 },
  { pause: 400, do: [click('#machine-pick'), { js: "setTimeout(() => document.querySelector('.mtab[data-device=\"\"]').click(), 500)" }] },
  { pause: 900 },
  { jarvis: 'Your Gmail is done, sir. Three new emails, and only the one from your landlord needs a reply today. Shall I draft it?', do: [{ type: 'stats', agents: [] }, { type: 'notice', text: 'Finished: checking your Gmail' }] },
  { you: "Not now. By the way, my sister Priya's birthday is on the fourteenth of November." },
  { jarvis: "Noted. I'll remind you a few days before, so there's time to get a gift.", view: 'memory', do: [{ type: 'memory', data: [...FACTS, priya] }, { type: 'schedule', data: [bank, ...SCHEDULE, gift] }] },
  { pause: 1500 },
  { jarvis: 'Five themes, sir, each in dark and light. Stark suits us, I think.', view: 'cc', themes: true },
  { you: 'Thanks, Jarvis.' },
  { jarvis: 'Always, sir.' },
  { pause: 1500 },
];

// ---------- audio ----------

function kokoro() {
  const py = spawn(path.join(ROOT, '.venv', 'bin', 'python3'), [path.join(ROOT, 'scripts', 'kokoro_server.py')]);
  const rl = readline.createInterface({ input: py.stdout });
  const waiting = new Map();
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  rl.on('line', (l) => { const m = JSON.parse(l); if (m.ready) ready(); else waiting.get(m.id)?.(m); });
  return {
    async say(text, out, voice = 'bm_george') {
      await readyP;
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve, reject) => {
        waiting.set(id, (m) => (m.ok ? resolve() : reject(new Error(m.error))));
        py.stdin.write(JSON.stringify({ id, text, voice, speed: 1.05, out }) + '\n');
      });
    },
    close: () => py.kill(),
  };
}

const seconds = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

const tts = kokoro();
let n = 0;
for (const line of SCRIPT) {
  if (!line.you && !line.jarvis) continue;
  line.file = path.join(TMP, `${String(n++).padStart(2, '0')}.${line.you ? 'aiff' : 'wav'}`);
  if (line.you) execFileSync('say', ['-v', USER_VOICE, '-r', '185', '-o', line.file, line.you]);
  else await tts.say(line.jarvis, line.file, line.voice);
  line.secs = seconds(line.file);
}
tts.close();

// ---------- timeline ----------

const events = [];   // [ms, action]
const clips = [];    // [ms, file]
let t = 600;
for (const line of SCRIPT) {
  if (line.pause) { for (const ev of line.do || []) events.push([t, { ev }]); t += line.pause; continue; }
  const ms = Math.round(line.secs * 1000);
  if (line.view) events.push([t - 300, { view: line.view }]);
  for (const ev of line.do || []) events.push([t, { ev }]);
  if (line.you) {
    events.push([t, { ev: { type: 'state', state: 'listening' } }]);
    const words = line.you.split(' ');
    words.forEach((_, i) => events.push([t + Math.round((ms * (i + 1)) / words.length), { ev: { type: 'transcript', text: words.slice(0, i + 1).join(' '), final: false } }]));
    clips.push([t, line.file]);
    t += ms + 350;
    events.push([t, { ev: { type: 'transcript', text: line.you.replace(/^Jarvis, /, ''), final: true } }]);
    events.push([t, { ev: { type: 'state', state: 'thinking' } }]);
    events.push([t, { ev: { type: 'reply', text: '' } }]);
    t += 650;
  } else {
    events.push([t, { ev: { type: 'state', state: 'speaking' } }]);
    events.push([t, { ev: { type: 'reply', text: line.jarvis } }]);
    if (line.themes) ['jarvis', 'terminal', 'neon', 'minimal', THEME].forEach((th, i) => events.push([t + 300 + i * 900, { theme: th }]));
    clips.push([t, line.file]);
    t += Math.max(ms, line.themes ? 4800 : 0) + 250;
    events.push([t, { ev: { type: 'state', state: 'idle' } }]);
    t += 450;
  }
}
const total = t;

// ---------- record ----------

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', recordVideo: { dir: TMP, size: { width: W, height: H } } });
const recStart = Date.now();
const page = await context.newPage();
await page.goto(`file://${ROOT}/src/renderer/hud/index.html?demo=1&tour=1&theme=${THEME}&mode=dark`);
await page.waitForTimeout(3500);
await page.evaluate(({ facts, schedule, agents }) => {
  window.hud.event(agents);
  window.hud.event({ type: 'memory', data: facts });
  window.hud.event({ type: 'schedule', data: schedule });
  window.hud.event({ type: 'state', state: 'idle' });
  window.hud.event({ type: 'reply', text: '' });
  window.hud.event({ type: 'transcript', text: '' });
  window.hud.event({ type: 'mode', conversation: false });
}, { facts: FACTS, schedule: SCHEDULE, agents: assistantsEvent() });
await page.waitForTimeout(500);
const offset = (Date.now() - recStart) / 1000;
await page.evaluate((events) => {
  for (const [ms, a] of events) {
    setTimeout(() => {
      if (a.ev && a.ev.js) new Function(a.ev.js)();
      else if (a.ev) window.hud.event(a.ev);
      if (a.view) document.querySelector(`#nav a[data-view="${a.view}"]`).click();
      if (a.theme) window.jarvisTheme.apply(a.theme, 'dark');
    }, ms);
  }
}, events);
await page.waitForTimeout(total + 500);
const video = await page.video().path();
await context.close();
await browser.close();

// ---------- mix and encode ----------

fs.mkdirSync(OUT, { recursive: true });
const wav = path.join(TMP, 'voice.wav');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...clips.flatMap(([, f]) => ['-i', f]),
  '-filter_complex', clips.map(([ms], i) => `[${i}:a]aresample=44100,adelay=${ms}|${ms},apad[a${i}]`).join(';') + ';' + clips.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${clips.length}:normalize=0,atrim=0:${total / 1000}[out]`,
  '-map', '[out]', wav]);
const mp4 = path.join(OUT, 'jarvis-demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(offset), '-i', video, '-i', wav, '-t', String(total / 1000),
  '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', mp4]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '25', '-i', mp4, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'poster.jpg')]);
// A looping, silent preview for the README, which can't play a video from the repo.
const gif = (src, dst, ss, t, width, colors) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...(ss ? ['-ss', String(ss), '-t', String(t)] : []), '-i', src,
  '-vf', `fps=${width > 800 ? 8 : 7},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, dst]);
gif(mp4, path.join(OUT, 'jarvis-demo.gif'), 19, 34, 720, 80);
for (const f of ['jarvis-demo.mp4', 'poster.jpg', 'jarvis-demo.gif']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1), 'MB');
console.log(`length ${(total / 1000).toFixed(1)} s`);
fs.rmSync(TMP, { recursive: true, force: true });
