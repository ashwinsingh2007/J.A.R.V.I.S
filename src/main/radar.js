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
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(PROJECTS, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(PROJECTS, d, f);
        let mod;
        try { mod = fs.statSync(full).mtimeMs; } catch { continue; }
        if (mod < cutoff) continue;
        const id = f.slice(0, -6);
        const isBrain = brainIds.has(id);
        if (isBrain && id !== currentBrain) continue;      // old brain sessions: noise
        const info = this.tail(full, d);
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

  /** Verbose tail of one session for the HUD's live panel. */
  detail(cwd, limit = 16) {
    const file = this.byCwd.get(cwd);
    if (!file) return [];
    const out = [];
    const hms = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toTimeString().slice(0, 8); };
    for (const obj of parseLines(readTail(file, 256 * 1024))) {
      if ((obj.type !== 'assistant' && obj.type !== 'user') || !obj.message) continue;
      const t = obj.timestamp ? hms(obj.timestamp) : '';
      const content = obj.message.content;
      if (obj.type === 'user') {
        if (typeof content === 'string') { if (!content.startsWith('<')) out.push({ t, kind: 'user', text: content.slice(0, 240) }); continue; }
        for (const b of content || []) {
          if (b.type === 'text' && b.text && !b.text.startsWith('<')) out.push({ t, kind: 'user', text: b.text.slice(0, 240) });
          else if (b.type === 'tool_result') {
            const c = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join(' ');
            if (c) out.push({ t, kind: 'result', text: c.replace(/\n/g, ' ').slice(0, 200) });
          }
        }
      } else {
        for (const b of content || []) {
          if (b.type === 'text' && b.text) out.push({ t, kind: 'assistant', text: b.text.slice(0, 400) });
          else if (b.type === 'tool_use') {
            const i = b.input || {};
            const s = String(i.command || i.file_path || i.pattern || i.query || i.url || i.description || '');
            out.push({ t, kind: 'tool', text: `${b.name} ${s.slice(0, 160)}` });
          }
        }
      }
    }
    return out.slice(-limit);
  }
}

module.exports = Radar;
