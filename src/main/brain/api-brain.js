// Brain providers without Claude Code: the Anthropic Messages API, Gemini (through
// its OpenAI-compatible endpoint) and Ollama. All run the same loop: stream a reply, run any tool calls, feed results
// back, repeat (max 8 rounds). History is kept in ~/.jarvis/<provider>-history.json.
// When it grows past the provider's limit, or a new day starts, older turns are summarised
// (context.js) and the history starts again from the summary and the latest turns.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const C = require('../config');
const { log } = require('../util');
const { SentenceSplitter, systemPrompt, summarise } = require('./common');
const tools = require('./tools');
const { Context } = require('./context');

const MAX_ROUNDS = 8;
const MAX_HISTORY = 40;
// Rough history size, in tokens, that triggers a summary. Ollama runs with an 8k window.
const ROLL_TOKENS = { anthropic: 40000, gemini: 40000, ollama: 4000 };
const RETRY_MS = 10 * 60 * 1000;

// A finished background job, handed to the brain to retell.
const REPORT = /^\[JOB REPORT\]/;

class ApiBrain extends EventEmitter {
  /** kind: "anthropic" | "gemini" | "ollama"; worker: runs background jobs, or null */
  /** fresh: forget the chat history (another assistant took over; the summary carries it). */
  constructor(cfg, kind, worker = null, { fresh = false } = {}) {
    super();
    this.cfg = cfg;
    this.kind = kind;
    this.worker = worker;
    if (worker) {
      for (const ev of ['task', 'progress']) worker.on(ev, (x) => this.emit(ev, x));
      worker.on('result', (r) => this.emit('job-result', r));
    }
    this.label = { anthropic: `anthropic api · ${cfg.anthropicModel}`, gemini: `gemini · ${cfg.geminiModel}`, ollama: `ollama · ${cfg.ollamaModel}` }[kind];
    this.isBusy = false;
    this.isReady = true;
    this.abort = null;
    this.historyFile = path.join(C.STATE_DIR, `${kind}-history.json`);
    try { this.history = fresh ? [] : JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch { this.history = []; }
    this.context = new Context('conversation', () => this.emit('context', this.contextInfo()), { learn: true });
    this.rollTimer = setInterval(() => { if (!this.isBusy) this.maybeRoll(); }, RETRY_MS).unref();
    this.splitter = new SentenceSplitter((s) => this.emit('sentence', s));
  }

  warmUp() { setTimeout(() => this.emit('ready', 0), 0); }

  /** Another assistant took over: stop for good. */
  dispose() {
    clearInterval(this.rollTimer);
    this.removeAllListeners();
    this.cancel();
    if (this.worker) { this.worker.removeAllListeners(); this.worker.stopAll(); }
  }

  /**
   * Tools and prompt note for this turn: the worker can be switched on and off in Settings. Retelling a
   * job report needs no tools, and a small model given tools there tends to redo the job instead.
   */
  get tools() {
    const t = tools.forBrain(!!this.worker && this.cfg.worker === 'claude-code');
    if (!REPORT.test(this.lastPrompt || '')) return t;
    return { ...t, specs: [] };
  }

  reset() {
    this.cancel();
    this.history = [];
    try { fs.unlinkSync(this.historyFile); } catch {}
    this.context.clear();
    this.freshWanted = false;
  }

  /** About four characters to a token. */
  get historyTokens() { return Math.round(JSON.stringify(this.history).length / 4); }

  /** What the HUD's Memory view shows about the conversation. */
  contextInfo() {
    const c = this.context;
    return { summary: c.summary, rolledAt: c.rolledAt, lines: c.lines.length, tokens: this.historyTokens, limit: ROLL_TOKENS[this.kind], rolling: !!this.rolling || !!this.rollWanted };
  }

  /** Summarise now, from the HUD. */
  rollNow() { this.rollWanted = true; if (!this.isBusy) this.maybeRoll(); }

  /** Summarise the older turns once the history is big or from yesterday, then start it again from the summary. */
  async maybeRoll() {
    if (this.rolling) return;
    if (!this.freshWanted) {
      if (!this.rollWanted && (Date.now() - (this.rollFailedAt || 0) < RETRY_MS || !this.context.due(this.historyTokens, ROLL_TOKENS[this.kind]))) return;
      this.rolling = true;
      this.rollWanted = false;
      this.emit('context', this.contextInfo());
      log(`context: rolling over at about ${this.historyTokens} tokens`);
      try {
        await this.context.roll((system, text) => this.complete(system, text));
        this.freshWanted = true;
      } catch (e) {
        this.rollFailedAt = Date.now();
        log(`context: summary failed, keeping the history: ${e.message || e}`);
      } finally { this.rolling = false; }
    }
    // A question that came in while summarising finishes on the old history first.
    if (this.freshWanted && !this.isBusy) {
      this.freshWanted = false;
      this.history = [];
      this.saveHistory();
    }
    this.emit('context', this.contextInfo());
  }

  /** One plain answer with no tools, for the summary. */
  async complete(system, text) {
    const signal = AbortSignal.timeout(120000);
    const post = async (url, headers, body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.json();
    };
    if (this.kind === 'anthropic') {
      const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': this.cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        { model: this.cfg.anthropicModel, max_tokens: 1024, system, messages: [{ role: 'user', content: text }] });
      return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (this.kind === 'gemini') {
      const r = await post('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', { authorization: `Bearer ${this.cfg.geminiApiKey}` },
        { model: this.cfg.geminiModel, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] });
      return (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
    }
    const r = await post(`${this.cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {},
      { model: this.cfg.ollamaModel, stream: false, think: false, keep_alive: '30m', options: { num_ctx: 8192 }, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] });
    return (r.message && r.message.content) || '';
  }

  cancel() {
    if (this.abort) this.abort.abort();
    this.abort = null;
    this.isBusy = false;
    this.splitter.reset();
  }

  saveHistory() {
    // Keep the tail, starting on a plain user message so tool pairs stay intact.
    let h = this.history.slice(-MAX_HISTORY);
    while (h.length && !(h[0].role === 'user' && typeof h[0].content === 'string')) h.shift();
    this.history = h;
    try { fs.writeFileSync(this.historyFile, JSON.stringify(h)); } catch {}
  }

  async ask(prompt) {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    this.isBusy = true;
    this.splitter.reset();
    const t0 = Date.now();
    this.dropUnansweredCall();
    const start = this.history.length;
    this.history.push({ role: 'user', content: prompt });
    this.context.asked(prompt);
    this.lastPrompt = prompt;
    log(`brain(${this.kind}): asked '${prompt.slice(0, 80)}'`);
    let final = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const round = { anthropic: this.anthropicRound, gemini: this.openaiRound, ollama: this.ollamaRound }[this.kind];
        const { text, calls } = await round.call(this, abort.signal);
        if (text) final += (final ? ' ' : '') + text;
        this.splitter.flush(true);
        if (!calls.length) break;
        for (const c of calls) this.emit('tool', { name: c.name, summary: summarise(c.name, c.input) });
        const results = [];
        for (const c of calls) results.push({ call: c, out: c.name === 'delegate' && this.worker && this.cfg.worker === 'claude-code' ? this.delegate(c.input) : await tools.execute(c.name, c.input, this.cfg) });
        if (abort.signal.aborted) return;
        this.pushToolResults(results);
        // Handed to the worker: the user has heard "on it", and the result comes back later. Stop here so the
        // model doesn't guess at an outcome it can't know yet.
        if (calls.some((c) => c.name === 'delegate')) { this.history.push(this.closing()); break; }
      }
      if (abort.signal.aborted) return;
      log(`timing: ${this.kind} done ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      this.isBusy = false;
      this.abort = null;
      this.saveHistory();
      if (final.trim() && !/^\W*SILENT\W*$/i.test(final.trim())) this.context.add('jarvis', final);
      this.emit('done', final, false);
      setImmediate(() => this.maybeRoll());
    } catch (e) {
      if (abort.signal.aborted) return;
      this.isBusy = false;
      this.abort = null;
      this.history.length = start;   // forget the whole failed turn, tool rounds included
      log(`brain(${this.kind}) error: ${e.message || e}`);
      this.emit('done', this.friendlyError(e), true);
    }
  }

  /**
   * A turn cancelled while its tools ran ends on a tool call with no result.
   * The API rejects that history, so drop the call before the next question.
   */
  dropUnansweredCall() {
    const last = this.history[this.history.length - 1];
    if (last && last.role === 'assistant' && (last.tool_calls || (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')))) this.history.pop();
  }

  /** The tools note plus the carried summary of earlier turns. */
  promptExtra(note) { return [note, this.skillsNote(), this.context.carried].filter(Boolean).join('\n\n'); }

  /** This brain can't run skills itself; its background worker can, so it knows to hand those jobs over. */
  skillsNote() {
    if (!this.worker || this.cfg.worker === 'off' || this.kind === 'ollama') return '';
    const names = require('../skills').chosen(this.cfg, this.cfg.assistant).map((x) => x.name);
    return names.length ? `Your background worker also has these skills, so delegate jobs they fit: ${names.slice(0, 80).join(', ')}.` : '';
  }

  /** Hand a job to the worker, with the user's own words attached so a vague instruction can't lose the request. */
  delegate(input = {}) {
    const words = REPORT.test(this.lastPrompt || '') || /^\[(BRIEFING|CHECK-IN|SCHEDULED TASK)\]/.test(this.lastPrompt || '') ? '' : `\n\nThe user's own words: "${String(this.lastPrompt || '').slice(0, 1000)}"`;
    return this.worker.start(input.description, `${String(input.task || '').trim()}${words}`);
  }

  /** A closing assistant turn after a handoff, so the next question starts on a clean history. */
  closing() {
    return this.kind === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } : { role: 'assistant', content: 'On it.' };
  }

  friendlyError(e) {
    const m = String(e.message || e);
    const name = { anthropic: 'Anthropic API', gemini: 'Gemini', ollama: 'Ollama' }[this.kind];
    if (this.kind === 'ollama' && /ECONNREFUSED|fetch failed/i.test(m)) return 'Ollama is not running. Start the Ollama app and try again.';
    if (/^(400|401|403)\b.*(api.?key|unauthenticated|permission)|invalid x-api-key|authentication/i.test(m)) return `The ${name} key was rejected. Check it in Setup.`;
    if (/^429\b/.test(m)) return `${name} says too many requests. Wait a moment and try again.`;
    return `The ${name} request failed: ${m.slice(0, 160)}`;
  }

  // ---------- Anthropic ----------

  async anthropicRound(signal) {
    const body = {
      model: this.cfg.anthropicModel,
      max_tokens: 1024,
      stream: true,
      system: systemPrompt(this.cfg, this.promptExtra(this.tools.note)),
      messages: this.history,
    };
    // No tools at all on a turn that only retells a report.
    if (this.tools.specs.length) body.tools = [
      ...this.tools.specs.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
    ];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

    const blocks = [];        // assistant content blocks, rebuilt from the stream
    let text = '';
    await readSSE(res, (ev) => {
      if (ev.type === 'content_block_start') {
        const b = { ...ev.content_block };
        if (b.type === 'tool_use' || b.type === 'server_tool_use') { b._json = ''; b.input = {}; }
        blocks[ev.index] = b;
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index];
        if (!b) return;
        if (ev.delta.type === 'text_delta') {
          b.text = (b.text || '') + ev.delta.text;
          text += ev.delta.text;
          this.emit('delta', ev.delta.text);
          this.splitter.push(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta' && '_json' in b) {
          b._json += ev.delta.partial_json;
        }
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b && '_json' in b) { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
        if (b && b.type === 'text') this.splitter.flush(true);
      } else if (ev.type === 'error') {
        throw new Error(ev.error && ev.error.message);
      }
    });
    const content = blocks.filter(Boolean);
    this.history.push({ role: 'assistant', content });
    const calls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { text, calls };
  }

  // ---------- Gemini (OpenAI-compatible chat completions) ----------

  async openaiRound(signal) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.geminiApiKey}` },
      body: JSON.stringify({
        model: this.cfg.geminiModel,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(this.cfg, this.promptExtra(this.tools.note)) }, ...this.history],
        ...(this.tools.specs.length ? { tools: this.tools.specs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    let text = '';
    const parts = [];     // tool calls rebuilt from the stream, by index
    await readSSE(res, (ev) => {
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      const d = (ev.choices && ev.choices[0] && ev.choices[0].delta) || {};
      if (d.content) {
        text += d.content;
        this.emit('delta', d.content);
        this.splitter.push(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? parts.length;
        const p = parts[i] || (parts[i] = { id: '', name: '', args: '' });
        if (tc.id) p.id = tc.id;
        if (tc.function && tc.function.name) p.name += tc.function.name;
        if (tc.function && tc.function.arguments) p.args += tc.function.arguments;
      }
    });
    const calls = parts.filter(Boolean).map((p, i) => {
      let input = {};
      try { input = p.args ? JSON.parse(p.args) : {}; } catch {}
      return { id: p.id || `call_${Date.now()}_${i}`, name: p.name, input };
    });
    const msg = { role: 'assistant', content: text || null };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    this.history.push(msg);
    return { text, calls };
  }

  // ---------- Ollama ----------

  async ollamaRound(signal) {
    // Small local models get the short prompt; Ollama's default context window would cut the full one off.
    const t = this.tools;
    const messages = [{ role: 'system', content: systemPrompt(this.cfg, this.promptExtra(''), { file: 'local.md', worker: t.specs.some((x) => x.name === 'delegate') }) }, ...this.history];
    const res = await fetch(`${this.cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.ollamaModel,
        stream: true,
        think: false,
        keep_alive: '30m',
        options: { num_ctx: 8192 },
        messages,
        ...(t.specs.length ? { tools: t.specs.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.schema } })) } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    let text = '';
    let held = '';           // a reply that starts with "{" may be a tool call written as text: hold it back
    const calls = [];
    await readNDJSON(res, (obj) => {
      if (obj.error) throw new Error(obj.error);
      const m = obj.message || {};
      if (m.content) {
        text += m.content;
        if (held || (!text.slice(0, -m.content.length).trim() && m.content.trim().startsWith('{'))) { held += m.content; return; }
        this.emit('delta', m.content);
        this.splitter.push(m.content);
      }
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        let input = fn.arguments || {};
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        calls.push({ name: fn.name, input });
      }
    });
    if (held) {
      // Small models sometimes write the call as JSON text. Use it if it parses; never read JSON aloud.
      const call = toolCallFromText(held);
      if (call) { calls.push(call); text = ''; log(`brain(ollama): tool call written as text: ${call.name}`); }
      else if (!/^\s*\{\s*"(name|function|parameters|arguments)"/.test(held)) { this.emit('delta', held); this.splitter.push(held); }
      else { text = ''; log('brain(ollama): dropped a malformed tool call written as text'); }
    }
    const msg = { role: 'assistant', content: text };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.input } }));
    this.history.push(msg);
    return { text, calls };
  }

  pushToolResults(results) {
    if (this.kind === 'anthropic') {
      this.history.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.out })) });
    } else if (this.kind === 'gemini') {
      for (const r of results) this.history.push({ role: 'tool', tool_call_id: r.call.id, content: r.out });
    } else {
      for (const r of results) this.history.push({ role: 'tool', tool_name: r.call.name, content: r.out });
    }
  }
}

/** {"name": "...", "parameters"|"arguments": {...}} written as plain text → a tool call, or null. */
function toolCallFromText(s) {
  try {
    const o = JSON.parse(s.trim());
    const name = o.name || (o.function && o.function.name);
    let input = o.parameters || o.arguments || (o.function && o.function.arguments) || {};
    if (typeof input === 'string') input = JSON.parse(input);
    return name && typeof input === 'object' ? { name, input } : null;
  } catch { return null; }
}

async function readSSE(res, onEvent) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) { try { onEvent(JSON.parse(data)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    }
  }
}

async function readNDJSON(res, onObj) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { let o; try { o = JSON.parse(line); } catch { continue; } onObj(o); }
    }
  }
}

module.exports = ApiBrain;
