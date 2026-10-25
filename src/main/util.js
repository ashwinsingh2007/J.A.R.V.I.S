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
// nvm / Homebrew are found when the app is launched from Finder.
let loginPath = null;
function env(extra = {}) {
  if (loginPath === null) {
    try { loginPath = execFileSync('/bin/zsh', ['-lc', 'echo -n $PATH'], { timeout: 8000 }).toString(); } catch { loginPath = ''; }
    if (!loginPath) loginPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  }
  return { ...process.env, PATH: loginPath, ...extra };
}

function which(name) {
  try { return execFileSync('/usr/bin/env', ['which', name], { env: env(), timeout: 5000 }).toString().trim() || null; } catch { return null; }
}

/** Run a command, resolve {out, err, code}. Never rejects. */
function run(exe, args, { timeout = 60000, cwd, input } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(exe, args, { env: env(), cwd }); } catch (e) { return resolve({ out: '', err: String(e), code: -1 }); }
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
function initPaths(appDir) {
  paths.root = C.findProjectRoot(appDir);
  paths.scripts = path.join(paths.root, 'scripts');
  paths.prompts = path.join(paths.root, 'prompts');
  paths.models = path.join(paths.root, 'models');
  paths.music = path.join(paths.root, 'music');
  paths.python = path.join(paths.root, '.venv', 'bin', 'python3');
  paths.edgeTTS = path.join(paths.root, '.venv', 'bin', 'edge-tts');
  return paths;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

module.exports = { log, env, which, run, jsonLines, clean, cutSources, SOURCES_START, paths, initPaths, sleep, hhmm };
