#!/usr/bin/env node
// The jarvis command: talk to JARVIS from the terminal, with or without the HUD.
//
//   jarvis                       chat in the terminal (type /help inside)
//   jarvis "check my mail"       ask once and print the reply
//   jarvis --on "Home Mac" "…"   hand a task to a paired computer and wait for its result
//   jarvis hud                   open the HUD
//   jarvis listen | mute         turn the mic and wake word on | standby
//   jarvis stop | new            stop the current answer | start a new conversation
//   jarvis status | quit         what JARVIS is doing | quit JARVIS
//
// If JARVIS isn't running, it starts in the background with no HUD and the mic off. It talks to
// JARVIS over the private socket in ~/.jarvis (owner only); nothing goes over the network.
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const STATE = process.env.JARVIS_STATE_DIR || path.join(os.homedir(), '.jarvis');
const SOCK = path.join(STATE, 'jarvis.sock');
const OPS = ['hud', 'listen', 'mute', 'stop', 'new', 'status', 'quit'];
const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `Talk to JARVIS from the terminal.

  jarvis                       chat in the terminal
  jarvis "check my mail"       ask once and print the reply
  jarvis --on "Home Mac" "…"   hand a task to a paired computer and wait for its result
  jarvis hud                   open the HUD
  jarvis listen                turn the mic and the wake word on
  jarvis mute                  standby: mic off
  jarvis stop                  stop the current answer
  jarvis new                   start a new conversation
  jarvis status                what JARVIS is doing
  jarvis quit                  quit JARVIS
  jarvis -- hud                send the word "hud" itself

If JARVIS isn't running, it starts in the background with no HUD and the mic off.
Replies are printed, not spoken.`;

/** Opens the socket, or null when JARVIS isn't running. */
function connect() {
  return new Promise((resolve) => {
    const c = net.connect(SOCK);
    c.once('connect', () => resolve(c));
    c.once('error', () => resolve(null));
  });
}

/** The app to start: JARVIS_APP, the build next to this checkout, or the one in Applications. */
function appPath() {
  const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
  return [process.env.JARVIS_APP, path.join(here, '..', 'JARVIS.app'), '/Applications/JARVIS.app'].find((p) => p && fs.existsSync(p));
}

/** Starts JARVIS when it isn't running: in the background, or with the HUD for "jarvis hud". */
async function ensureRunning(withHud = false) {
  const c = await connect();
  if (c) { c.destroy(); return true; }
  const app = appPath();
  if (!app) { console.error(red('JARVIS.app not found. Build it with ./build.sh, or set JARVIS_APP.')); return false; }
  console.error(dim(withHud ? 'Starting JARVIS…' : 'Starting JARVIS in the background (no HUD, mic off)…'));
  const env = process.env.JARVIS_STATE_DIR ? ['--env', `JARVIS_STATE_DIR=${process.env.JARVIS_STATE_DIR}`] : [];
  execFileSync('/usr/bin/open', withHud ? [...env, '-a', app] : [...env, '-g', '-a', app, '--args', '--headless']);
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const s = await connect();
    if (s) { s.destroy(); return true; }
  }
  console.error(red('JARVIS did not start in 30 seconds. See ~/.jarvis/jarvis.log.'));
  return false;
}

/** One request, one JSON answer. */
async function call(req, timeoutMs = 15000) {
  const c = await connect();
  if (!c) return null;
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => { c.destroy(); resolve({ ok: false, text: 'No answer from JARVIS.' }); }, timeoutMs);
    c.on('data', (d) => { buf += d; });
    c.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, text: 'No answer from JARVIS.' }); } });
    c.write(JSON.stringify(req) + '\n');
  });
}

/** Types a line to JARVIS and prints the reply as it comes. Ctrl-C stops the answer: closing the
 *  socket early stops the turn. hold(socket) lets the chat do that from its own Ctrl-C. */
async function say(text, hold = () => {}) {
  const c = await connect();
  if (!c) { console.error(red('JARVIS is not running.')); return false; }
  hold(c);
  return new Promise((resolve) => {
    let buf = '', printed = false, ok = true, done = false;
    const sigint = () => c.destroy();
    process.once('SIGINT', sigint);
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let ev = {};
        try { ev = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        if (ev.t === 'tool') {
          if (printed) { process.stdout.write('\n'); printed = false; }
          console.log(dim(`  · ${ev.text}`));
        } else if (ev.t === 'reply') {
          process.stdout.write((printed ? ' ' : '') + ev.text);
          printed = true;
        } else if (ev.t === 'done') {
          done = true;
          if (ev.error) { ok = false; console.log((printed ? '\n' : '') + red(ev.text)); printed = false; }
          else if (ev.text) { process.stdout.write((printed ? ' ' : '') + ev.text); printed = true; }
          else if (ev.cancelled) { if (printed) process.stdout.write('\n'); printed = false; console.error(dim('(stopped)')); }
        }
      }
    });
    c.on('close', () => {
      process.removeListener('SIGINT', sigint);
      hold(null);
      if (printed) process.stdout.write('\n');
      if (!done) console.error(dim('(stopped)'));
      resolve(done && ok);
    });
    c.write(JSON.stringify({ op: 'say', text }) + '\n');
  });
}

function showStatus(r) {
  console.log(`${r.agent} (${r.brain}): ${r.state}. Mic ${r.mic}. HUD ${r.hud ? 'open' : 'closed'}.`);
  console.log(r.jobs.length ? `Jobs: ${r.jobs.join('; ')}` : 'No jobs running.');
}

/** jarvis hud, listen, mute, …: returns the exit code. */
async function op(name) {
  if (name === 'hud') { if (!(await ensureRunning(true))) return 1; }
  else if (name === 'listen') { if (!(await ensureRunning())) return 1; }
  const r = await call({ op: name === 'status' ? 'info' : name });
  if (!r) { console.error('JARVIS is not running.'); return 1; }
  if (name === 'status' && r.ok) showStatus(r);
  else console.log(r.text || 'No answer.');
  return r.ok ? 0 : 1;
}

async function chat() {
  if (!(await ensureRunning())) return 1;
  const s = await call({ op: 'info' });
  if (s && s.ok) console.log(dim(`${s.agent} · ${s.brain} · mic ${s.mic}. Type /help for commands, Ctrl-D to leave.`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ', historySize: 200 });
  // Ctrl-C stops the answer being written; at the prompt it leaves, as in a shell.
  let busy = null;
  let closed = false;
  rl.on('SIGINT', () => { if (busy) busy.destroy(); else rl.close(); });
  rl.on('close', () => { closed = true; });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (t === '/exit' || t === 'exit') break;
    if (t === '/help') console.log(dim('/hud /listen /mute /stop /new /status /quit (quits JARVIS) /exit (leaves this chat). Ctrl-C stops an answer.'));
    else if (t.startsWith('/') && OPS.includes(t.slice(1))) { await op(t.slice(1)); if (t === '/quit') break; }
    else if (t) await say(t, (c) => { busy = c; });
    if (!closed) rl.prompt();    // input piped in may have ended during the answer
  }
  rl.close();
  return 0;
}

async function main(argv) {
  // JARVIS's own brain and workers may not type to it as if they were the user.
  if (process.env.JARVIS) { console.error('The jarvis command is for the user. It does not run inside JARVIS.'); return 2; }
  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') { console.log(HELP); return 0; }
  if (!argv.length) return chat();
  if (argv[0] === '--on') {
    if (argv.length < 3) { console.error('jarvis --on "<device>" "<task>"'); return 2; }
    if (!(await ensureRunning())) return 1;
    const task = argv.slice(2).join(' ');
    console.error(dim(`Asking ${argv[1]}. A task can take minutes…`));
    const r = await call({ op: 'ask', device: argv[1], description: task.slice(0, 60), task }, 46 * 60000);
    console.log(r ? r.text || 'No answer.' : 'JARVIS is not running.');
    return r && r.ok ? 0 : 1;
  }
  if (argv.length === 1 && OPS.includes(argv[0])) return op(argv[0]);
  const text = (argv[0] === '--' ? argv.slice(1) : argv).join(' ');
  if (!(await ensureRunning())) return 1;
  return (await say(text)) ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
