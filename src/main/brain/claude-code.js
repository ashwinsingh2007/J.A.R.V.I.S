// Brain provider: Claude Code itself. One long-lived `claude -p` process with
// stream-json on stdin and stdout, so the ~4 s start-up is paid once. It runs
// in bypassPermissions mode and hands tasks to its background worker, a subagent
// ("worker") with every tool that lives inside this same process. When a job finishes,
// Claude Code starts a turn on its own; those turns are reported as
// 'background' events instead of answers to the user.
//
// Turns are told apart with --replay-user-messages: a turn that begins with
// the echo of our own message answers the user, any other turn was started by
// a task notification.
//
// Agents report progress two ways: task_progress events (the tool they are
// running) and `STATUS:` lines they write between steps. Both become
// 'progress' events so JARVIS can tell the user how the job is going.
//
// The session doesn't grow forever: when its context passes ROLL_TOKENS, or a new
// day starts, older turns are summarised (context.js) and the brain starts a fresh
// session that carries the summary and the latest turns.
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const C = require('../config');
const { log, env, run, jsonLines } = require('../util');
const { Context } = require('./context');
const { memoryEnv } = require('../memory');
const { SentenceSplitter, systemPrompt, workerPrompt, summarise, claudeSettings, claudeExtras, claudeDisallowed } = require('./common');

const ENDED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled']);
// A fresh brain starts at about 23k tokens (prompt, tools, worker); this leaves about 45k for the conversation.
const ROLL_TOKENS = 70000;
const RETRY_MS = 10 * 60 * 1000;

/** "Running mcp__claude-in-chrome__navigate" → "navigate in Chrome"; "Running List files" → "List files". */
function stepText(d) {
  let t = String(d).replace(/^Running\s+/, '').trim();
  const mcp = /^mcp__([\w-]+?)__(\w+)/.exec(t);
  if (mcp) t = `${mcp[2].replace(/_/g, ' ')}${/chrome/i.test(mcp[1]) ? ' in Chrome' : ''}`;
  return t.slice(0, 120);
}

class ClaudeCodeBrain extends EventEmitter {
  /** fresh: start a new session (another assistant took over) instead of resuming the last one. */
  constructor(cfg, claudePath, { fresh = false } = {}) {
    super();
    this.cfg = cfg;
    this.claudePath = claudePath;
    this.label = `claude code · ${cfg.model}`;
    this.proc = null;
    this.isBusy = false;
    this.finalText = '';
    this.turn = null;            // 'user' | 'bg' | null (between turns)
    this.discard = false;        // the user's turn was cancelled: swallow the rest
    this.bgText = '';
    this.tasks = new Map();      // running background agents: task_id -> description
    this.jobs = new Map();       // task_id -> { description } until its result arrives
    this.agentTools = new Map(); // Agent tool_use_id -> task_id, to place subagent messages
    this.splitter = new SentenceSplitter((s) => { if (!this.discard) this.emit('sentence', s); });
    try { this._sessionId = fresh ? null : fs.readFileSync(C.SESSION_FILE, 'utf8').trim() || null; } catch { this._sessionId = null; }
    if (fresh) try { fs.writeFileSync(C.SESSION_FILE, ''); } catch {}
    this.context = new Context('conversation', () => this.emit('context', this.contextInfo()), { learn: true });
    this.contextTokens = 0;      // the main thread's context size at its last reply
    // A new day rolls the session over even if nobody talks.
    this.rollTimer = setInterval(() => this.maybeRoll(), RETRY_MS).unref();
  }

  /** Another assistant took over: stop for good. */
  dispose() {
    clearInterval(this.rollTimer);
    this.removeAllListeners();
    this.kill();
  }

  get isReady() { return !!this.proc; }

  get sessionId() { return this._sessionId; }
  set sessionId(s) {
    if (!s || s === this._sessionId) { this._sessionId = s; return; }
    this._sessionId = s;
    try { fs.writeFileSync(C.SESSION_FILE, s); } catch {}
    // Remember every brain session so the session radar can hide them.
    let known = '';
    try { known = fs.readFileSync(C.BRAIN_SESSIONS_FILE, 'utf8'); } catch {}
    if (!known.includes(s)) fs.appendFileSync(C.BRAIN_SESSIONS_FILE, s + '\n');
  }

  warmUp() { this.ensure(); }

  reset() {
    this._sessionId = null;
    try { fs.unlinkSync(C.SESSION_FILE); } catch {}
    this.context.clear();
    this.contextTokens = 0;
    this.freshWanted = false;
    this.kill();
  }

  /** What the HUD's Memory view shows about the conversation. */
  contextInfo() {
    const c = this.context;
    return { summary: c.summary, rolledAt: c.rolledAt, lines: c.lines.length, tokens: this.contextTokens, limit: ROLL_TOKENS, rolling: !!this.rolling || !!this.rollWanted };
  }

  /** Summarise now, from the HUD. Runs as soon as nothing is running. */
  rollNow() { this.rollWanted = true; this.emit('context', this.contextInfo()); this.maybeRoll(); }

  /** Fold the older turns into the summary once the context is big or from yesterday, then start fresh. */
  async maybeRoll() {
    if (this.rolling || this.freshWanted) return;
    if (!this.rollWanted && (Date.now() - (this.rollFailedAt || 0) < RETRY_MS || !this.context.due(this.contextTokens, ROLL_TOKENS))) return;
    if (this.isBusy || this.tasks.size || this.turn) return;
    this.rolling = true;
    this.rollWanted = false;
    this.emit('context', this.contextInfo());
    log(`context: rolling over at ${this.contextTokens} tokens`);
    try {
      await this.context.roll((system, text) => this.complete(system, text));
      this.freshWanted = true;
      this.maybeFresh();
    } catch (e) {
      this.rollFailedAt = Date.now();
      log(`context: summary failed, keeping the session: ${e.message || e}`);
    } finally { this.rolling = false; this.emit('context', this.contextInfo()); }
  }

  /** A new session that starts from the carried context. Waits until nothing is running. */
  maybeFresh() {
    if (!this.freshWanted || this.isBusy || this.tasks.size || this.turn) return;
    this.freshWanted = false;
    log(`context: fresh session (was ${this._sessionId || '-'})`);
    this._sessionId = null;
    try { fs.unlinkSync(C.SESSION_FILE); } catch {}
    this.contextTokens = 0;
    this.emit('context', this.contextInfo());
    this.restartWanted = false;      // the new process picks up any new settings too
    this.kill();
    this.ensure();
  }

  /** One plain answer with no tools and no saved session, for the summary. */
  async complete(system, text) {
    const r = await run(this.claudePath, ['-p', '--model', this.cfg.model, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--system-prompt', system], { input: text, timeout: 180000, cwd: C.HOME });
    if (r.code !== 0) throw new Error((r.err || r.out || `exit ${r.code}`).trim().slice(0, 200));
    return r.out;
  }

  /**
   * Model, effort or prompt settings changed. Restarting the process would
   * kill running agents, so it waits until the brain is idle and no agent runs.
   */
  reconfigure() {
    this.label = `claude code · ${this.cfg.model}`;
    this.restartWanted = true;
    this.maybeRestart();
  }

  maybeRestart() {
    this.maybeFresh();
    this.maybeRoll();
    if (!this.restartWanted) return;
    if (!this.proc) { this.restartWanted = false; return; }     // the next start picks the settings up
    if (this.isBusy || this.tasks.size || this.turn) return;
    this.restartWanted = false;
    log('brain: restarting with new settings');
    this.kill();
    this.ensure();
  }

  /** Running background agents, for the HUD. */
  get runningTasks() { return [...this.tasks.values()]; }

  /**
   * Stop answering the current question. An interrupt also kills every
   * background agent, so while agents run the turn is left to finish and its
   * output is swallowed instead. Brain turns are short, so that costs little.
   */
  cancel() {
    if (!this.isBusy || this.discard) return;
    this.discard = true;
    this.splitter.reset();
    if (this.tasks.size || !this.proc) return;
    this.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
    // Fallback: if the interrupt is ignored, restart on the same session.
    const p = this.proc;
    setTimeout(() => { if (this.proc === p && this.isBusy && this.discard && !this.tasks.size) { log('brain: interrupt ignored, restarting'); this.kill(); this.ensure(); } }, 5000);
  }

  ask(prompt) {
    this.ensure();
    if (!this.proc) { this.emit('done', "I couldn't start Claude Code.", true); return; }
    this.isBusy = true;
    this.discard = false;
    this.turnStart = Date.now();
    this.firstDelta = true;
    this.handedOff = false;
    this.finalText = '';
    this.splitter.reset();
    this.context.asked(prompt);
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    log(`brain: asked '${prompt.slice(0, 80)}' session=${this._sessionId || 'new'}`);
  }

  /** The one background worker: every tool, and the whole job from start to finish. */
  agents() {
    return JSON.stringify({
      worker: {
        description: "Your background worker, with every tool: coding, web search and research, files, websites in the user's signed-in Chrome, email, chats and social media, checking and cleaning the Mac, reviews and checks. Give it one complete, self-contained instruction with every part of the job.",
        prompt: workerPrompt(this.cfg),
        model: this.cfg.agentModel,
        background: true,
      },
    });
  }

  ensure() {
    if (this.proc) return;
    fs.mkdirSync(`${C.STATE_DIR}/agents/tmp`, { recursive: true });
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--replay-user-messages',
      '--model', this.cfg.model, '--effort', this.cfg.effort,
      '--append-system-prompt', systemPrompt(this.cfg, this.context.carried),
      '--dangerously-skip-permissions',
      '--agents', this.agents(),
      '--chrome',
      // New terminals only come from the user.
      '--disallowedTools', claudeDisallowed(this.cfg, { brain: true }),
      '--setting-sources', '',
      '--settings', claudeSettings(this.cfg),
      // This assistant's skills and MCP servers (its background worker, a subagent, gets them too).
      ...claudeExtras(this.cfg),
    ];
    if (this._sessionId) args.push('--resume', this._sessionId);
    let p;
    try {
      p = spawn(this.claudePath, args, { env: env({ JARVIS: '1', ...memoryEnv(this.cfg) }), cwd: C.HOME });
    } catch (e) { log(`brain: failed to start claude: ${e}`); return; }
    this.proc = p;
    this.startedAt = Date.now();
    this.warmed = false;
    log(`brain: started claude pid ${p.pid} model=${this.cfg.model} resume=${this._sessionId || '-'}`);
    jsonLines(p.stdout, (obj) => this.handle(obj));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (s) => {
      if (!s.trim()) return;
      log(`brain stderr: ${s.slice(0, 300)}`);
      if (s.toLowerCase().includes('no conversation found')) this._sessionId = null;
    });
    p.on('error', (e) => log(`brain: ${e}`));
    p.on('exit', (code) => {
      log(`brain: claude exited (${code})`);
      if (this.proc !== p) return;
      this.proc = null;
      this.dropTasks();
      if (this.isBusy) {
        this.isBusy = false;
        this.splitter.flush(true);
        this.emit('done', this.finalText || 'Claude Code stopped unexpectedly.', !this.finalText);
      }
    });
  }

  kill() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.removeAllListeners('exit');
    p.kill('SIGTERM');
    this.dropTasks();
    this.turn = null;
    if (this.isBusy) { this.isBusy = false; this.splitter.reset(); }
  }

  /** The process is gone, and its background agents with it. */
  dropTasks() {
    if (!this.tasks.size) return;
    log(`brain: ${this.tasks.size} background agent(s) lost`);
    for (const [id, description] of this.tasks) this.emit('task', { id, description, status: 'killed' });
    this.tasks.clear();
    this.jobs.clear();
    this.agentTools.clear();
  }

  onTask(obj) {
    if (obj.subtype === 'task_started') {
      // Only agents the brain itself started; their own sub-tasks don't count.
      if (obj.owned_by_subagent || obj.parent_task_id || !obj.is_backgrounded) return;
      this.tasks.set(obj.task_id, obj.description || 'task');
      this.jobs.set(obj.task_id, { description: obj.description || 'task' });
      if (obj.tool_use_id) this.agentTools.set(obj.tool_use_id, obj.task_id);
      log(`brain: worker started '${obj.description}'`);
      this.emit('task', { id: obj.task_id, description: obj.description, status: 'running', task: String(obj.prompt || '') });
      return;
    }
    // The finished job's report. The brain retells it on its own; this copy is for the HUD.
    if (obj.subtype === 'task_notification') {
      const job = this.jobs.get(obj.task_id);
      if (job && !job.reported && typeof obj.summary === 'string') {
        job.reported = true;
        if (!this.tasks.has(obj.task_id)) this.jobs.delete(obj.task_id);
        this.context.add('worker', obj.summary);
        this.emit('job-report', { id: obj.task_id, description: job.description, text: obj.summary, ok: obj.status === 'completed' });
      }
    }
    if (obj.subtype === 'task_progress') {
      if (!this.tasks.has(obj.task_id) || obj.owned_by_subagent) return;
      const step = stepText(obj.description || obj.last_tool_name || '');
      if (step) this.emit('progress', { id: obj.task_id, step, tools: (obj.usage && obj.usage.tool_uses) || 0 });
      return;
    }
    const status = obj.subtype === 'task_updated' ? obj.patch && obj.patch.status : obj.status;
    if (!ENDED.has(status) || !this.tasks.has(obj.task_id)) return;
    const description = this.tasks.get(obj.task_id);
    this.tasks.delete(obj.task_id);
    for (const [tool, id] of this.agentTools) if (id === obj.task_id) this.agentTools.delete(tool);
    const job = this.jobs.get(obj.task_id) || {};
    if (job.reported) this.jobs.delete(obj.task_id);
    log(`brain: worker ${status} '${description}'`);
    this.emit('task', { id: obj.task_id, description, status });
    setImmediate(() => this.maybeRestart());
  }

  /** A message from inside a running agent: pick out the `STATUS:` lines it writes for the user. */
  onAgentMessage(obj) {
    if (obj.type !== 'assistant') return;
    const id = this.agentTools.get(obj.parent_tool_use_id);
    if (!id || !this.tasks.has(id)) return;
    for (const b of (obj.message && obj.message.content) || []) {
      if (b.type !== 'text') continue;
      const m = /(?:^|\n)\s*STATUS:\s*(.+)/.exec(b.text || '');
      if (!m) continue;
      log(`brain: agent status '${m[1].trim().slice(0, 80)}'`);
      this.emit('progress', { id, status: m[1].trim().slice(0, 160) });
    }
  }

  handle(obj) {
    // Subagent traffic is never spoken directly; only its STATUS lines are used.
    if (obj.parent_tool_use_id) { this.onAgentMessage(obj); return; }
    switch (obj.type) {
      case 'system':
        if (obj.subtype && obj.subtype.startsWith('task_')) { this.onTask(obj); break; }
        if (obj.subtype !== 'init') break;
        this.turn = null;
        if (obj.session_id && !this._sessionId) this.sessionId = obj.session_id;
        if (!this.warmed) {
          this.warmed = true;
          const secs = (Date.now() - this.startedAt) / 1000;
          log(`timing: claude ready in ${secs.toFixed(2)}s`);
          // What this assistant can use, as Claude Code loaded it.
          this.loaded = { skills: (obj.skills || []).length, mcp: (obj.mcp_servers || []).map((m) => `${m.name} ${m.status}`) };
          log(`brain: ${this.loaded.skills} skills, MCP ${this.loaded.mcp.join(', ') || 'none'}`);
          this.emit('ready', secs);
        }
        break;
      case 'user':
        // The echo of our own message: this turn answers the user.
        if (obj.isReplay && this.isBusy && this.turn !== 'user') this.turn = 'user';
        break;
      case 'stream_event': {
        if (!this.turn) this.turn = 'bg';
        const ev = obj.event || {};
        if (this.turn === 'bg') {
          if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') this.bgText += ev.delta.text;
          break;
        }
        // Once a job is handed to an agent the user has heard "on it"; a second remark after it is noise.
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use' && ['Agent', 'Task'].includes(ev.content_block.name)) this.handedOff = true;
        if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
          if (this.discard || this.handedOff) break;
          if (this.firstDelta) { this.firstDelta = false; log(`timing: first token ${((Date.now() - this.turnStart) / 1000).toFixed(2)}s`); }
          this.emit('delta', ev.delta.text);
          this.splitter.push(ev.delta.text);
        } else if (ev.type === 'content_block_stop') {
          this.splitter.flush(true);
        }
        break;
      }
      case 'assistant': {
        const u = obj.message && obj.message.usage;
        if (u) this.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!this.turn) this.turn = 'bg';
        if (this.turn === 'bg' || this.discard) break;
        for (const b of (obj.message && obj.message.content) || []) {
          if (b.type === 'tool_use') this.emit('tool', { name: b.name, summary: summarise(b.name, b.input) });
        }
        break;
      }
      case 'result': {
        if (obj.session_id) this.sessionId = obj.session_id;
        const turn = this.turn || (this.isBusy ? 'user' : 'bg');
        this.turn = null;
        if (turn === 'bg') {
          const text = (typeof obj.result === 'string' && obj.result) || this.bgText;
          this.bgText = '';
          log(`brain: background turn '${text.slice(0, 80)}'`);
          if (!obj.is_error && text.trim() && !/^\W*SILENT\W*$/i.test(text.trim())) { this.context.add('jarvis', text.trim()); this.emit('background', text.trim()); }
          setImmediate(() => this.maybeRestart());
          break;
        }
        if (this.discard) {
          log('brain: cancelled turn finished');
          this.discard = false;
          this.isBusy = false;
          this.splitter.reset();
          this.emit('done', '', false, true);
          setImmediate(() => this.maybeRestart());
          break;
        }
        this.emit('context', this.contextInfo());
        const isError = !!obj.is_error;
        if (typeof obj.result === 'string') this.finalText = obj.result;
        if (isError && Array.isArray(obj.errors) && obj.errors.length) this.finalText = obj.errors.join('. ');
        log(`timing: claude done ${((Date.now() - this.turnStart) / 1000).toFixed(2)}s`);
        this.splitter.flush(true);
        this.isBusy = false;
        if (!isError && !/^\W*SILENT\W*$/i.test(this.finalText.trim())) this.context.add('jarvis', this.finalText);
        this.emit('done', this.finalText, isError);
        setImmediate(() => this.maybeRestart());
        break;
      }
    }
  }
}

module.exports = ClaudeCodeBrain;
