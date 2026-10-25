// Brain providers without Claude Code: the Anthropic Messages API and Ollama.
// Both run the same loop: stream a reply, run any tool calls, feed results
// back, repeat (max 8 rounds). History is kept in ~/.jarvis/<provider>-history.json.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const C = require('../config');
const { log } = require('../util');
const { SentenceSplitter, systemPrompt, summarise } = require('./common');
const tools = require('./tools');

const MAX_ROUNDS = 8;
const MAX_HISTORY = 40;

class ApiBrain extends EventEmitter {
  /** kind: "anthropic" | "ollama" */
  constructor(cfg, kind) {
    super();
    this.cfg = cfg;
    this.kind = kind;
    this.label = kind === 'anthropic' ? `anthropic api · ${cfg.anthropicModel}` : `ollama · ${cfg.ollamaModel}`;
    this.isBusy = false;
    this.isReady = true;
    this.abort = null;
    this.historyFile = path.join(C.STATE_DIR, `${kind}-history.json`);
    try { this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch { this.history = []; }
    this.splitter = new SentenceSplitter((s) => this.emit('sentence', s));
  }

  warmUp() { setTimeout(() => this.emit('ready', 0), 0); }

  reset() {
    this.cancel();
    this.history = [];
    try { fs.unlinkSync(this.historyFile); } catch {}
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
    this.history.push({ role: 'user', content: prompt });
    log(`brain(${this.kind}): asked '${prompt.slice(0, 80)}'`);
    let final = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const { text, calls } = this.kind === 'anthropic' ? await this.anthropicRound(abort.signal) : await this.ollamaRound(abort.signal);
        if (text) final += (final ? ' ' : '') + text;
        this.splitter.flush(true);
        if (!calls.length) break;
        for (const c of calls) this.emit('tool', { name: c.name, summary: summarise(c.name, c.input) });
        const results = [];
        for (const c of calls) results.push({ call: c, out: await tools.execute(c.name, c.input) });
        if (abort.signal.aborted) return;
        this.pushToolResults(results);
      }
      if (abort.signal.aborted) return;
      log(`timing: ${this.kind} done ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      this.isBusy = false;
      this.abort = null;
      this.saveHistory();
      this.emit('done', final, false);
    } catch (e) {
      if (abort.signal.aborted) return;
      this.isBusy = false;
      this.abort = null;
      this.history.pop();
      log(`brain(${this.kind}) error: ${e.message || e}`);
      this.emit('done', this.friendlyError(e), true);
    }
  }

  friendlyError(e) {
    const m = String(e.message || e);
    if (this.kind === 'ollama' && /ECONNREFUSED|fetch failed/i.test(m)) return 'Ollama is not running. Start the Ollama app and try again.';
    if (/401|invalid x-api-key|authentication/i.test(m)) return 'The Anthropic API key was rejected. Check it in Settings.';
    return `The ${this.kind === 'ollama' ? 'Ollama' : 'Anthropic API'} request failed: ${m.slice(0, 160)}`;
  }

  // ---------- Anthropic ----------

  async anthropicRound(signal) {
    const body = {
      model: this.cfg.anthropicModel,
      max_tokens: 1024,
      stream: true,
      system: systemPrompt(this.cfg, tools.TOOL_NOTE),
      messages: this.history,
      tools: [
        ...tools.SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ],
    };
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

  // ---------- Ollama ----------

  async ollamaRound(signal) {
    const messages = [{ role: 'system', content: systemPrompt(this.cfg, tools.TOOL_NOTE) }, ...this.history];
    const res = await fetch(`${this.cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.ollamaModel,
        stream: true,
        messages,
        tools: tools.SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    let text = '';
    const calls = [];
    await readNDJSON(res, (obj) => {
      if (obj.error) throw new Error(obj.error);
      const m = obj.message || {};
      if (m.content) {
        text += m.content;
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
    const msg = { role: 'assistant', content: text };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.input } }));
    this.history.push(msg);
    return { text, calls };
  }

  pushToolResults(results) {
    if (this.kind === 'anthropic') {
      this.history.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.out })) });
    } else {
      for (const r of results) this.history.push({ role: 'tool', tool_name: r.call.name, content: r.out });
    }
  }
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
