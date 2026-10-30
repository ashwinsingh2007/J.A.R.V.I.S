// Records the terminal demo: the jarvis chat talking to a scripted stand-in for JARVIS (made-up data,
// nothing from this Mac), typed in a pseudo-terminal, then drawn with xterm.js in Chrome and saved as
// docs/demo/jarvis-terminal.mp4 with a poster frame.
//
//   node tools/make-terminal-demo.mjs        (needs Google Chrome, ffmpeg and python3; fetches xterm.js)
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'demo');
// A short folder: a Unix socket's path has to fit in about 100 characters.
const TMP = fs.mkdtempSync('/tmp/jdemo-');
const SOCK = path.join(TMP, 'jarvis.sock');
const COLS = 104, ROWS = 30;

// ---------- the stand-in: answers the jarvis command the way JARVIS would ----------

const AGENTS = [['jarvis', 'JARVIS', 'None'], ['friday', 'FRIDAY', 'Coding'], ['karen', 'KAREN', 'Communications'], ['edith', 'EDITH', 'Maintains JARVIS'], ['vision', 'VISION', 'Research']];
const state = { id: 'jarvis', jobs: [], tokens: 18400 };
const name = () => AGENTS.find((a) => a[0] === state.id)[1];
const info = () => ({ ok: true, agent: name(), id: state.id, brain: state.id === 'friday' ? 'claude code · opus' : 'claude code · sonnet', state: 'idle', hud: false, mic: 'off', jobs: state.jobs, context: { tokens: state.tokens, limit: 70000 } });
const watchers = new Set();
const feed = (ev) => { for (const w of watchers) w.write(JSON.stringify(ev) + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What each typed line gets: sentences as they stream, tool lines, and a job that reports in the background.
const TURNS = [
  [/how many agents/i, { think: 1500, say: ['Five, sir.', '**FRIDAY** for code, **KAREN** for your messages, **EDITH** looks after me, and **VISION** for research.'] }],
  [/hacker news/i, { think: 1700, say: ['Checking Hacker News now, sir.'], tool: 'agent: checking Hacker News for AI stories', job: {
    what: 'checking Hacker News for AI stories',
    steps: [[900, 'step', 'Opening news.ycombinator.com'], [1300, 'step', 'Reading the top 30 stories'], [1400, 'progress', 'Found two AI stories. Opening the one with more points.'], [1500, 'step', 'Reading the article and the top comments']],
    result: 'The top AI story is a new open-weights model that runs on a laptop, sir, with 412 points and a lively thread. Shall I summarise it?',
  } }],
  [/remind me/i, { think: 1100, say: ["Done. I'll remind you at five."] }],
];

async function say(c, text) {
  const turn = (TURNS.find(([re]) => re.test(text)) || [null, { think: 800, say: ['Of course.'] }])[1];
  const send = (ev) => c.write(JSON.stringify(ev) + '\n');
  await sleep(turn.think);
  for (const s of turn.say) { send({ t: 'reply', text: s }); await sleep(450); }
  if (turn.tool) { send({ t: 'tool', text: turn.tool }); await sleep(300); }
  state.tokens += 900;
  send({ t: 'done', text: '' });
  c.end();
  if (turn.job) runJob(turn.job);
}

async function runJob(j) {
  await sleep(500);
  state.jobs = [j.what];
  feed({ t: 'job', state: 'running', text: j.what });
  for (const [ms, t, text] of j.steps) { await sleep(ms); feed({ t, job: j.what, text }); }
  await sleep(1200);
  state.jobs = [];
  feed({ t: 'job', state: 'completed', text: j.what });
  await sleep(400);
  feed({ t: 'said', who: name(), text: j.result });
}

function answer(q) {
  switch (q.op) {
    case 'info': return info();
    case 'agents': return { ok: true, current: state.id, agents: AGENTS.map(([id, n, role]) => ({ id, name: n, role, custom: false })) };
    case 'agent': { const a = AGENTS.find((x) => x[1].toLowerCase() === String(q.name).toLowerCase()); if (!a) return { ok: false, text: 'No agent by that name.' }; state.id = a[0]; return { ok: true, text: `${a[1]} has taken over.` }; }
    case 'list': return { ok: true, me: 'MacBook', devices: [{ id: 'home', name: 'Home Mac', os: 'macOS', via: 'local network', lastSeen: '' }, { id: 'office', name: 'Office PC', os: 'Windows', via: 'offline', lastSeen: '2026-10-30T18:02' }] };
    case 'status': return { ok: true, name: 'Home Mac', os: 'macOS', assistant: 'FRIDAY', busy: true, cpu: 14, ramUsed: 16.3, ramTotal: 32, jobs: ['refactoring the payments module'] };
    default: return { ok: false, text: 'Not in this demo.' };
  }
}

const server = net.createServer((c) => {
  let buf = '', got = false;
  c.on('error', () => {});
  c.on('data', (d) => {
    if (got) return;
    buf += d;
    if (!buf.includes('\n')) return;
    got = true;
    const q = JSON.parse(buf.slice(0, buf.indexOf('\n')));
    if (q.op === 'say') return say(c, q.text);
    if (q.op === 'watch') { watchers.add(c); c.on('close', () => watchers.delete(c)); return; }
    c.end(JSON.stringify(answer(q)) + '\n');
  });
});
await new Promise((r) => server.listen(SOCK, r));

// ---------- type it in a pseudo-terminal ----------

const timeline = [
  [2.2, 'how many agents do you have?'], [0.5, '\r'],
  [5.0, '/devices'], [0.5, '\r'],
  [3.0, 'check Hacker News and tell me the top AI story'], [0.5, '\r'],
  [12.5, 'remind me at five to call the bank'], [0.5, '\r'],
  [4.0, '/agent friday'], [0.5, '\r'],
  [3.5, '\x04'],
];
fs.writeFileSync(path.join(TMP, 'timeline.json'), JSON.stringify(timeline));
const cast = path.join(TMP, 'demo.cast');
await new Promise((resolve, reject) => {
  const p = spawn('python3', ['-I', path.join(ROOT, 'tools', 'term-record.py'), String(COLS), String(ROWS), path.join(TMP, 'timeline.json'), cast, 'node', path.join(ROOT, 'scripts', 'jarvis.mjs')], {
    env: { ...process.env, JARVIS_STATE_DIR: TMP, JARVIS: '', TERM: 'xterm-256color' }, stdio: 'inherit',
  });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`recorder exited ${code}`))));
});
server.close();
if (process.env.CAST_OUT) fs.copyFileSync(cast, process.env.CAST_OUT);
const lines = fs.readFileSync(cast, 'utf8').trim().split('\n');
// The shell before the chat: typing "jarvis" at a prompt.
const lead = [[0.3, 'o', '\x1b[1m~\x1b[0m % '], ...'jarvis'.split('').map((ch, i) => [0.8 + i * 0.09, 'o', ch]), [1.5, 'o', '\r\n']];
const events = [...lead, ...lines.slice(1).map((l) => JSON.parse(l)).map(([t, k, d]) => [t + 1.6, k, d])];
const total = events[events.length - 1][0] + 1.5;

// ---------- draw it with xterm.js and record ----------

const page_html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<style>
  html, body { margin: 0; height: 100%; background: radial-gradient(ellipse at 50% 30%, #2a1408, #0a0503 70%); display: grid; place-items: center; font-family: -apple-system, sans-serif; }
  .win { background: #120b07; border: 1px solid #3a2414; border-radius: 12px; box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 60px rgba(255,140,40,.08); overflow: hidden; }
  .bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #1c120b; border-bottom: 1px solid #2c1c10; color: #a58a72; font-size: 13px; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .bar span { margin: 0 auto; transform: translateX(-30px); }
  #t { padding: 10px 14px 14px; }
</style></head><body>
<div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>jarvis — zsh</span></div><div id="t"></div></div>
<script>
  const term = new Terminal({ cols: ${COLS}, rows: ${ROWS}, fontFamily: 'Menlo, monospace', fontSize: 15, lineHeight: 1.0, cursorBlink: true,
    theme: { background: '#120b07', foreground: '#f1e4d6', cursor: '#ffb347', selectionBackground: '#4a2c16' } });
  term.open(document.getElementById('t'));
  window.play = (events) => { for (const [t, , d] of events) setTimeout(() => term.write(d), t * 1000); };
</script></body></html>`;
fs.writeFileSync(path.join(TMP, 'term.html'), page_html);
const W = 1280, H = 820;
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const recStart = Date.now();
const page = await context.newPage();
await page.goto(`file://${path.join(TMP, 'term.html')}`);
await page.waitForFunction(() => typeof window.play === 'function' && document.querySelector('.xterm-screen'));
await page.waitForTimeout(800);
const offset = (Date.now() - recStart) / 1000;
await page.evaluate((ev) => window.play(ev), events);
await page.waitForTimeout(total * 1000);
const video = await page.video().path();
await context.close();
await browser.close();

fs.mkdirSync(OUT, { recursive: true });
const mp4 = path.join(OUT, 'jarvis-terminal.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(offset), '-i', video, '-t', String(total),
  '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.min(total - 1, 31)), '-i', mp4, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'terminal-poster.jpg')]);
for (const f of ['jarvis-terminal.mp4', 'terminal-poster.jpg']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1), 'MB');
console.log(`length ${total.toFixed(1)} s`);
fs.rmSync(TMP, { recursive: true, force: true });
