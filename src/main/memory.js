// What JARVIS remembers: durable facts about the user (memory.json, written by
// scripts/memory.py, the HUD and the fact pass before each summary) and a plain journal of each
// day's exchanges (journal/YYYY-MM-DD.md), used for the morning recap and check-ins.
//
// The facts are shared by every assistant. Each assistant also has a memory of its own
// (assistants/<id>/memory.json) that only it reads, and can stop reading the shared one
// (assistantSettings[id].sharedMemory = false), in which case everything it learns goes to its own.
//
// events: 'change' (facts)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const C = require('./config');
const { log } = require('./util');

const FILE = path.join(C.STATE_DIR, 'memory.json');
const JOURNAL = path.join(C.STATE_DIR, 'journal');
const TOPICS = ['person', 'preference', 'project', 'place', 'routine', 'other'];
// Never kept, whoever asks: passwords, keys, codes and card numbers.
const SECRET = /\b(passwords?|passcodes?|passphrases?|otp|cvv|api[ -]?keys?|secret keys?|private keys?|access tokens?)\b|\b(?:\d[ -]?){13,19}\b|[A-Za-z0-9_-]{28,}/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** An assistant's own memory file. */
const ownFile = (id) => path.join(C.STATE_DIR, 'assistants', String(id).replace(/[^a-z0-9-]/g, ''), 'memory.json');

class Memory extends EventEmitter {
  /** file: the shared memory by default, or one assistant's own (ownFile). */
  constructor(file = FILE) {
    super();
    this.file = file;
    this.facts = [];
    this.load();
  }

  load() {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.facts = data && Array.isArray(data.facts) ? data.facts : [];
    if (!data && this.file === FILE) this.migrate();
  }

  /** The old memory.md held one fact per line. */
  migrate() {
    let lines = [];
    try { lines = fs.readFileSync(C.MEMORY_FILE, 'utf8').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean); } catch { return; }
    if (!lines.length) return;
    const now = new Date().toISOString().slice(0, 16);
    this.facts = lines.map((text) => ({ id: 'm' + crypto.randomBytes(3).toString('hex'), text, topic: 'other', added: now }));
    this.save();
    log(`memory: moved ${lines.length} facts from memory.md`);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ facts: this.facts }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** memory.py writes the file from the brain's shell; pick that up. */
  watch() {
    let t = null;
    fs.watchFile(this.file, { interval: 1500 }, () => {
      clearTimeout(t);
      t = setTimeout(() => { this.load(); this.emit('change', this.facts); }, 200);
    });
  }

  add(text, topic = 'other') {
    text = String(text || '').trim().slice(0, 400);
    if (!text || this.facts.some((f) => f.text.toLowerCase() === text.toLowerCase())) return;
    this.facts.push({ id: 'm' + crypto.randomBytes(3).toString('hex'), text, topic, added: new Date().toISOString().slice(0, 16) });
    this.save();
    this.emit('change', this.facts);
  }

  /**
   * Facts the pass before a summary picked out: [{ text, topic, replaces }]. A fact that updates
   * one already known replaces it. Returns how many changed.
   */
  learn(items) {
    this.load();
    let n = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const text = String((it && it.text) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!text || SECRET.test(text) || this.facts.some((f) => norm(f.text) === norm(text))) continue;
      const fact = { id: 'm' + crypto.randomBytes(3).toString('hex'), text, topic: TOPICS.includes(it.topic) ? it.topic : 'other', added: new Date().toISOString().slice(0, 16), learnt: true };
      const old = it.replaces ? this.facts.findIndex((f) => f.id === it.replaces) : -1;
      if (old >= 0) { log(`memory: '${this.facts[old].text.slice(0, 60)}' -> '${text.slice(0, 60)}'`); this.facts[old] = fact; }
      else this.facts.push(fact);
      n++;
    }
    if (n) { this.save(); this.emit('change', this.facts); log(`memory: learnt ${n} fact(s)`); }
    return n;
  }

  forget(id) {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    if (this.facts.length === before) return false;
    this.save();
    this.emit('change', this.facts);
    return true;
  }

  /** For the system prompt. */
  promptText() {
    return this.facts.map((f) => `- ${f.text}`).join('\n');
  }

  // ---------- journal ----------

  journal(who, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const d = new Date();
    try {
      fs.mkdirSync(JOURNAL, { recursive: true });
      fs.appendFileSync(path.join(JOURNAL, `${day(d)}.md`), `- ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${who}: ${text.slice(0, 500)}\n`, { mode: 0o600 });
    } catch (e) { log(`journal: ${e.message}`); }
  }

  /** A day's journal; offset -1 is yesterday. */
  readJournal(offset = 0, max = 4000) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    try { const t = fs.readFileSync(path.join(JOURNAL, `${day(d)}.md`), 'utf8'); return t.length > max ? '…' + t.slice(-max) : t; } catch { return ''; }
  }
}

/** Whether an assistant reads the shared memory (on unless the user switched it off). */
const usesShared = (cfg, id = cfg.assistant) => ((cfg.assistantSettings || {})[id] || {}).sharedMemory !== false;

/** Where what an assistant learns goes: the shared memory, or its own when it doesn't use the shared one. */
function learnInto(cfg) {
  return new Memory(usesShared(cfg) ? FILE : ownFile(cfg.assistant));
}

/** The memory part of an assistant's prompt: the shared facts (if it uses them), then its own. */
function promptFor(cfg, how = 'use it naturally, never recite it') {
  const shared = usesShared(cfg) ? new Memory().promptText() : '';
  const own = new Memory(ownFile(cfg.assistant)).promptText();
  let text = '';
  if (shared) text += `\n\nWHAT YOU KNOW ABOUT THE USER (from memory; ${how}):\n${shared}`;
  if (own) text += `\n\nYOUR OWN MEMORY (only you keep these; ${how}):\n${own}`;
  return text;
}

/** For memory.py, run from the assistant's brain: which assistant it is and whether it uses the shared memory. */
const memoryEnv = (cfg) => ({ JARVIS_AGENT: String(cfg.assistant || 'jarvis'), JARVIS_SHARED_MEMORY: usesShared(cfg) ? '1' : '0' });

module.exports = { Memory, day, SECRET, ownFile, usesShared, learnInto, promptFor, memoryEnv };
