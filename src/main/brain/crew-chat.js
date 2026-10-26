// Talking to a crew member directly. FRIDAY, KAREN, EDITH and VISION each keep their own ongoing
// Claude Code session with the user, so they remember what the two of them said. Each message runs
// `claude -p --resume <their session>` with their persona; JARVIS doesn't route it, he only hears
// about it. Long chats roll over like the brain's: older turns are summarised (context.js) and the
// next message starts a fresh session that carries the summary and the latest turns.
//
// Events:
//   'progress' { agent, step } or { agent, status }   (STATUS: lines they write)
//   'reply'    { agent, text, ok }
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const C = require('../config');
const { log, env, run, jsonLines } = require('../util');
const { CREW, crewName, VISION_ARGS, agentPrompt, claudeSettings, claudeDisallowed, fill, read } = require('./common');
const { Context } = require('./context');

const FILE = path.join(C.STATE_DIR, 'crew-chat.json');
// A crew session starts at about 20k tokens (persona, rules, tools); this leaves room for a long chat.
const ROLL_TOKENS = 70000;
const MAX_MINUTES = 30;

class CrewChat extends EventEmitter {
  constructor(cfg, claudePath) {
    super();
    this.cfg = cfg;
    this.claudePath = claudePath;
    this.sessions = {};          // id -> { session, tokens }
    try { this.sessions = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch {}
    this.contexts = Object.fromEntries(CREW.map((id) => [id, new Context(`crew-${id}`, () => {}, { self: id, seed: false, learn: true })]));
    this.running = new Map();    // id -> { proc, text, result, error }
  }

  busy(id) { return this.running.has(id); }

  save() { try { fs.writeFileSync(FILE, JSON.stringify(this.sessions), { mode: 0o600 }); } catch {} }

  /** Send the user's message to one crew member. Returns false if they are still on the last one. */
  say(id, text) {
    if (!CREW.includes(id) || this.running.has(id)) return false;
    const s = this.sessions[id] || (this.sessions[id] = {});
    const ctx = this.contexts[id];
    const prompt = [agentPrompt(this.cfg, id), fill(read('crew-direct.md', ''), this.cfg).replaceAll('{{ME}}', id), s.session ? '' : ctx.carried].filter(Boolean).join('\n\n');
    const args = [
      '-p', text,
      '--output-format', 'stream-json', '--verbose',
      '--model', this.cfg.agentModel === 'inherit' ? 'opus' : this.cfg.agentModel,
      '--append-system-prompt', prompt,
      '--dangerously-skip-permissions',
      '--disallowedTools', claudeDisallowed(this.cfg),
      '--setting-sources', '',
      '--settings', claudeSettings(),
      ...(id === 'vision' ? VISION_ARGS : ['--chrome']),
      ...(s.session ? ['--resume', s.session] : []),
    ];
    let proc;
    try { proc = spawn(this.claudePath, args, { env: env({ JARVIS: '1', JARVIS_WORKER: '1' }), cwd: C.HOME, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log(`${id} chat: failed to start: ${e}`); return false; }
    const job = { proc, text: '', result: '', error: false };
    job.timer = setTimeout(() => { log(`${id} chat: ran over ${MAX_MINUTES} min, stopping`); proc.kill('SIGTERM'); }, MAX_MINUTES * 60000);
    this.running.set(id, job);
    ctx.add('user', text);
    log(`${id} chat: '${text.slice(0, 80)}' session=${s.session || 'new'}`);
    jsonLines(proc.stdout, (obj) => this.handle(id, job, obj));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      if (!d.trim()) return;
      log(`${id} chat stderr: ${d.slice(0, 200)}`);
      if (d.toLowerCase().includes('no conversation found')) { s.session = ''; this.save(); }
    });
    proc.on('error', (e) => log(`${id} chat: ${e}`));
    proc.on('exit', (code) => this.finish(id, job, code));
    return true;
  }

  handle(id, job, obj) {
    const s = this.sessions[id];
    if (obj.session_id && obj.session_id !== s.session) { s.session = obj.session_id; this.save(); remember(obj.session_id); }
    if (obj.type === 'assistant' && !obj.parent_tool_use_id) {
      const u = obj.message && obj.message.usage;
      if (u) s.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const b of (obj.message && obj.message.content) || []) {
        if (b.type === 'text') {
          job.text = b.text || job.text;
          const m = /(?:^|\n)\s*STATUS:\s*(.+)/.exec(b.text || '');
          if (m) this.emit('progress', { agent: id, status: m[1].trim().slice(0, 160) });
        } else if (b.type === 'tool_use') {
          const mcp = /^mcp__([\w-]+?)__(\w+)/.exec(String(b.name));
          this.emit('progress', { agent: id, step: mcp ? `${mcp[2].replace(/_/g, ' ')}${/chrome/i.test(mcp[1]) ? ' in Chrome' : ''}` : String(b.name).slice(0, 60) });
        }
      }
    } else if (obj.type === 'result') {
      job.result = typeof obj.result === 'string' ? obj.result : job.text;
      job.error = !!obj.is_error;
    }
  }

  finish(id, job, code) {
    clearTimeout(job.timer);
    if (this.running.get(id) === job) this.running.delete(id);
    // What they say aloud: their reply without STATUS lines. A RESULT: paragraph out of habit repeats
    // the reply, so it is dropped, unless it is all there is.
    let text = String(job.result || job.text || '').split('\n').filter((l) => !/^\s*STATUS:/.test(l)).join('\n').trim();
    const r = text.search(/^\s*RESULT(?:\s*\(\w+\))?:/m);
    if (r > 0 && text.slice(0, r).trim()) text = text.slice(0, r).trim();
    else text = text.replace(/^\s*RESULT(?:\s*\(\w+\))?:\s*/m, '').trim();
    const ok = code === 0 && !job.error && !!text;
    log(`${id} chat: ${job.killed ? 'stopped' : ok ? 'replied' : `failed (exit ${code})`}`);
    if (job.killed) return;
    if (ok) this.contexts[id].add(id, text);
    this.emit('reply', { agent: id, text: text || `${crewName(id)} couldn't answer that.`, ok });
    this.maybeRoll(id);
  }

  /** A long or day-old chat: summarise it, and start the next message on a fresh session. */
  async maybeRoll(id) {
    const s = this.sessions[id] || {};
    const ctx = this.contexts[id];
    if (this.running.has(id) || ctx.rolling || !ctx.due(s.tokens || 0, ROLL_TOKENS)) return;
    ctx.rolling = true;
    try {
      await ctx.roll(async (system, text) => {
        const r = await run(this.claudePath, ['-p', '--model', this.cfg.model, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--system-prompt', system], { input: text, timeout: 180000, cwd: C.HOME });
        if (r.code !== 0) throw new Error((r.err || r.out || `exit ${r.code}`).trim().slice(0, 200));
        return r.out;
      });
      if (!this.running.has(id)) { s.session = ''; s.tokens = 0; this.save(); }
    } catch (e) {
      log(`${id} chat: summary failed, keeping the session: ${e.message || e}`);
    } finally { ctx.rolling = false; }
  }

  stop(id) {
    const job = this.running.get(id);
    if (!job) return false;
    job.killed = true;
    job.proc.kill('SIGTERM');
    this.running.delete(id);
    return true;
  }

  /** Forget a crew member's chat (or everyone's). */
  reset(id) {
    for (const x of id ? [id] : CREW) {
      this.stop(x);
      this.sessions[x] = {};
      this.contexts[x].clear();
    }
    this.save();
  }
}

/** Crew chat sessions are JARVIS's own: the session radar hides them like old brain sessions. */
function remember(session) {
  let known = '';
  try { known = fs.readFileSync(C.BRAIN_SESSIONS_FILE, 'utf8'); } catch {}
  if (!known.includes(session)) try { fs.appendFileSync(C.BRAIN_SESSIONS_FILE, session + '\n'); } catch {}
}

module.exports = { CrewChat };
