// Logging, paths and child-process helpers shared by the main process.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const C = require('./config');

const t0 = Date.now();
const pad = (n, w = 2) => String(n).padStart(w, '0');

function log(msg) {
  const d = new Date();
  const line = `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} +${String(Date.now() - t0).padStart(6)}ms] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(C.LOG_FILE, line); } catch {}
}

// PATH as a login shell sees it, so `claude`, `ollama`, `ffmpeg` installed via
// nvm, Homebrew or apt are found when the app is launched from Finder or a
// desktop entry, where the inherited PATH is a bare system one.
// Windows hands GUI processes the complete user PATH from the registry, so
// there is nothing to recover and no shell to ask.
const SHELLS = process.platform === 'darwin'
  ? ['/bin/zsh', '/bin/bash', '/bin/sh']
  : ['/bin/bash', '/bin/sh'];
const FALLBACK_PATH = process.platform === 'win32' ? ''
  : process.platform === 'darwin' ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The shells to ask, in order: the user's own, then the platform's usual one. */
function shellsToAsk() {
  const own = process.env.SHELL && fs.existsSync(process.env.SHELL) ? [process.env.SHELL] : [];
  const usual = SHELLS.find((sh) => fs.existsSync(sh) && !own.includes(sh));
  return [...own, usual].filter(Boolean);
}
const lastLine = (out) => { const l = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean); return l.length ? l[l.length - 1] : ''; };

// The answer is kept between runs: asking login shells can take seconds (a slow profile), and the
// first caller would otherwise wait for it at startup. A start uses the kept one and asks again quietly.
const PATH_CACHE = path.join(C.STATE_DIR, 'login-path.txt');

function shellPathLater() {
  if (process.platform === 'win32') return;
  const { execFile } = require('child_process');
  const seen = new Set();
  const ask = (list) => {
    if (!list.length) {
      const p = [...seen].join(':');
      if (p) { loginPath = p; try { fs.writeFileSync(PATH_CACHE, p, { mode: 0o600 }); } catch {} }
      return;
    }
    execFile(list[0], ['-lc', 'printf %s "$PATH"'], { timeout: 15000, encoding: 'utf8' }, (_e, out) => {
      for (const dir of lastLine(out).split(':')) if (dir) seen.add(dir);
      ask(list.slice(1));
    });
  };
  ask(shellsToAsk());
}

function shellPath() {
  if (process.platform === 'win32') return '';
  // Ask the user's own shell and the platform's usual one, and keep the entries from both, in that order.
  // The user's shell is the one whose rc files usually set PATH up, but on a Mac whose login shell is bash,
  // tools are often set up for zsh, the default, so stopping at the first answer would miss them.
  const seen = new Set();
  for (const sh of shellsToAsk()) {
    try {
      // Take the last line: a profile is free to print warnings before it is asked.
      const lines = execFileSync(sh, ['-lc', 'printf %s "$PATH"'], { timeout: 8000, encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length) for (const dir of lines[lines.length - 1].split(':')) if (dir) seen.add(dir);
    } catch {}
  }
  return [...seen].join(':');
}

let loginPath;               // undefined until the first call
function env(extra = {}) {
  if (loginPath === undefined) {
    let kept = '';
    try { kept = fs.readFileSync(PATH_CACHE, 'utf8').trim(); } catch {}
    if (kept) { loginPath = kept; shellPathLater(); }
    else { loginPath = shellPath() || FALLBACK_PATH; try { if (loginPath && process.platform !== 'win32') fs.writeFileSync(PATH_CACHE, loginPath, { mode: 0o600 }); } catch {} }
  }
  // An empty value means "leave the inherited PATH alone".
  return { ...process.env, ...(loginPath ? { PATH: loginPath } : {}), ...extra };
}

/** Absolute path to `name` on PATH, or null. Done in-process: there is no
 *  `/usr/bin/env which` to lean on, and Windows has no `which` either. */
function which(name) {
  if (!name) return null;
  const candidates = process.platform === 'win32' && !path.extname(name)
    ? [name, ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((e) => name + e)]
    : [name];
  for (const dir of String(env().PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const c of candidates) {
      const p = path.join(dir, c);
      try {
        if (!fs.statSync(p).isFile()) continue;
        // POSIX behaves like `which`: the file has to be runnable by us.
        if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

const runnable = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
};

/** Where Claude Code's installers put `claude`, for when PATH doesn't say:
 *  a login shell skips ~/.zshrc, which is often the only place PATH gets it. */
function claudeLocations(home = C.HOME) {
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let nodes = [];
  try { nodes = fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => path.join(nvm, v, 'bin', 'claude')); } catch {}
  return [
    path.join(home, '.local', 'bin', 'claude'),        // native installer
    path.join(home, '.claude', 'local', 'claude'),     // older "local" install
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    ...nodes,
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
  ];
}

let claudePath = null;
let shellMissAt = 0;        // an interactive shell is slow, so a miss is remembered for a minute
/** Absolute path to Claude Code's `claude`, or null: PATH first, then the usual
 *  install locations, then an interactive shell, which reads ~/.zshrc. */
function findClaude({ home = C.HOME, usePath = true, shell = process.env.SHELL } = {}) {
  if (usePath && claudePath && runnable(claudePath)) return claudePath;
  let found = (usePath && which('claude')) || claudeLocations(home).find(runnable) || null;
  if (!found && shell && process.platform !== 'win32' && fs.existsSync(shell) && Date.now() - shellMissAt > 60000) {
    try {
      const last = execFileSync(shell, ['-ilc', 'command -v claude'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split('\n').pop().trim();
      if (path.isAbsolute(last) && runnable(last)) found = last;
    } catch {}
    if (!found) shellMissAt = Date.now();
  }
  if (found && usePath) { claudePath = found; if (!which('claude')) log(`claude: not on PATH, using ${found}`); }
  return found;
}

/** Run a command, resolve {out, err, code}. Never rejects. */
function run(exe, args, { timeout = 60000, cwd, input, extraEnv } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(exe, args, { env: env(extraEnv), cwd }); } catch (e) { return resolve({ out: '', err: String(e), code: -1 }); }
    const timer = setTimeout(() => p.kill('SIGTERM'), timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += String(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code: code ?? -1 }); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

/** Line-delimited JSON reader for a child's stdout. */
function jsonLines(stream, onObj) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try { onObj(JSON.parse(line)); } catch {}
    }
  });
}

/** Strip markdown and other things that sound wrong when read aloud. */
function clean(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Links and citations are for reading, not for listening.
    .replace(/\s*\([^()]*?(?:https?:\/\/|www\.)[^()]*\)/g, '')
    .replace(/(?:https?:\/\/|www\.)\S+/g, '')
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Text before a trailing "Sources:" / "References:" list, which is never read aloud. */
function cutSources(text) {
  const m = /(^|\n)\s*(?:\*\*|#+\s*)?(?:sources?|references?|citations?|further reading|links?)\b\s*(?:\*\*)?\s*:?/i.exec(String(text || ''));
  return m ? text.slice(0, m.index) : String(text || '');
}

/** One sentence of a reply starts a sources list. */
const SOURCES_START = /^\W*(?:sources?|references?|citations?|further reading|links?)\b\s*(?:\*\*)?\s*:/i;

const paths = {};
// A venv keeps its launchers in bin/ on macOS and Linux, Scripts/ on Windows.
const VENV_BIN = process.platform === 'win32' ? 'Scripts' : 'bin';
function initPaths(appDir) {
  paths.root = C.findProjectRoot(appDir);
  paths.scripts = path.join(paths.root, 'scripts');
  paths.prompts = path.join(paths.root, 'prompts');
  paths.models = path.join(paths.root, 'models');
  paths.music = path.join(paths.root, 'music');
  paths.python = path.join(paths.root, '.venv', VENV_BIN, process.platform === 'win32' ? 'python.exe' : 'python3');
  paths.edgeTTS = path.join(paths.root, '.venv', VENV_BIN, process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts');
  return paths;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

module.exports = { log, env, which, findClaude, claudeLocations, run, jsonLines, clean, cutSources, SOURCES_START, paths, initPaths, sleep, hhmm };
