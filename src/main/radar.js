// Watches every Claude Code session on this Mac by tailing the transcripts in
// ~/.claude/projects. Feeds the HUD session cards. JARVIS's own brain
// session is tagged kind "jarvis"; everything else is "claude".
//
// events: 'update' (sessions)
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const C = require('./config');

const PROJECTS = path.join(C.HOME, '.claude', 'projects');

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const parseLines = (text) => text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function ago(s) {
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

class Radar extends EventEmitter {
  constructor() {
    super();
    this.byCwd = new Map();   // cwd -> newest transcript path
    this.tails = new Map();   // transcript path -> { mod, size, info, scan }: a file is only read again once it changed
    this.scans = 0;
  }

  start(interval = 4000) { this.timer = setInterval(() => this.scan(), interval); this.scan(); }

  scan() { setImmediate(() => this.emit('update', this.collect())); }

  collect() {
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let brainIds = new Set(), currentBrain = '';
    try { brainIds = new Set(fs.readFileSync(C.BRAIN_SESSIONS_FILE, 'utf8').split('\n').filter(Boolean)); } catch {}
    try { currentBrain = fs.readFileSync(C.SESSION_FILE, 'utf8').trim(); } catch {}
    const out = [];
    const newest = new Map();
    const scan = ++this.scans;
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(PROJECTS, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(PROJECTS, d, f);
        let mod, size;
        try { ({ mtimeMs: mod, size } = fs.statSync(full)); } catch { continue; }
        if (mod < cutoff) continue;
        const id = f.slice(0, -6);
        const isBrain = brainIds.has(id);
        if (isBrain && id !== currentBrain) continue;      // old brain sessions: noise
        let known = this.tails.get(full);
        if (!known || known.mod !== mod || known.size !== size) this.tails.set(full, known = { mod, size, info: this.tail(full, d) });
        known.scan = scan;
        const info = known.info;
        const age = (Date.now() - mod) / 1000;
        if (!newest.has(info.cwd) || newest.get(info.cwd).mod < mod) newest.set(info.cwd, { file: full, mod });
        out.push({
          id, cwd: info.cwd, last: info.last, modified: mod / 1000, ago: ago(age),
          name: isBrain ? 'JARVIS brain' : path.basename(info.cwd),
          status: age < 90 ? 'working' : (age < 1800 ? 'idle' : 'done'),
          kind: isBrain ? 'jarvis' : 'claude',
        });
      }
    }
    for (const [file, v] of this.tails) if (v.scan !== scan) this.tails.delete(file);   // gone, or older than a day
    for (const [cwd, v] of newest) this.byCwd.set(cwd, v.file);
    const seen = new Set();
    return out.sort((a, b) => b.modified - a.modified).filter((s) => !seen.has(s.cwd) && seen.add(s.cwd)).slice(0, 14);
  }

  /** cwd + last assistant text from the last ~96 KB of a transcript. */
  tail(file, dirName) {
    let cwd = '', last = '';
    for (const obj of parseLines(readTail(file, 96 * 1024)).reverse()) {
      if (!cwd && obj.cwd) cwd = obj.cwd;
      if (!last && obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        for (const b of obj.message.content) {
          if (b.type === 'text' && b.text) { last = b.text.replace(/\n/g, ' ').slice(0, 160); break; }
          if (b.type === 'tool_use') { last = `using ${b.name}`; break; }
        }
      }
      if (cwd && last) break;
    }
    return { cwd: cwd || dirName.replace(/-/g, '/'), last };
  }

  /** One session as a conversation for the HUD's right panel: the user's prompts and Claude's replies, no tool traffic. */
  conversation(cwd, limit = 30) {
    const file = this.byCwd.get(cwd);
    if (!file) return [];
    const out = [];
    const hhmm = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); };
    for (const obj of parseLines(readTail(file, 512 * 1024))) {
      if ((obj.type !== 'assistant' && obj.type !== 'user') || !obj.message || obj.isSidechain || obj.isMeta) continue;
      const t = obj.timestamp ? hhmm(obj.timestamp) : '';
      const content = obj.message.content;
      const texts = typeof content === 'string' ? [content] : (content || []).filter((b) => b.type === 'text' && b.text).map((b) => b.text);
      for (const raw of texts) {
        const text = raw.trim();
        if (!text || (obj.type === 'user' && text.startsWith('<'))) continue;
        const who = obj.type === 'user' ? 'you' : 'claude';
        const prev = out[out.length - 1];
        // Claude's text between tool calls in one reply reads as one message.
        if (prev && prev.who === who && who === 'claude') { prev.text = `${prev.text}\n\n${text}`.slice(-4000); continue; }
        out.push({ t, who, name: who === 'you' ? 'YOU' : 'CLAUDE', text: text.slice(0, 4000) });
      }
    }
    return out.slice(-limit);
  }
}

module.exports = Radar;
