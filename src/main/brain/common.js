// Shared pieces for every brain provider.
//
// A brain is an EventEmitter with:
//   events:  'delta' (text), 'sentence' (text), 'tool' ({name, summary}),
//            'done' (finalText, isError), 'ready' (seconds)
//   methods: warmUp(), ask(prompt), cancel(), reset()
//   fields:  isBusy, isReady, label
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { paths } = require('../util');

/** Emits complete sentences as soon as they appear so speech starts early. */
class SentenceSplitter {
  constructor(onSentence) { this.onSentence = onSentence; this.reset(); }
  reset() { this.buf = ''; this.spokeFirst = false; }
  push(text) { this.buf += text; this.flush(false); }
  flush(force) {
    // A long first sentence: speak up to a comma so the user hears something quickly.
    if (!this.spokeFirst && this.buf.length > 70 && !/[.!?]\s/.test(this.buf)) {
      const comma = this.buf.lastIndexOf(',');
      if (comma > 25) {
        const chunk = this.buf.slice(0, comma + 1).trim();
        this.buf = this.buf.slice(comma + 1);
        this.spokeFirst = true;
        this.onSentence(chunk);
      }
    }
    let m;
    while ((m = /([.!?])\s+/.exec(this.buf))) {
      const s = this.buf.slice(0, m.index + 1).trim();
      this.buf = this.buf.slice(m.index + m[0].length);
      if (s) { this.spokeFirst = true; this.onSentence(s); }
    }
    if (force) {
      const rest = this.buf.trim();
      this.buf = '';
      if (rest) this.onSentence(rest);
    }
  }
}

/** Placeholders, and the screen-control parts (between <!--screen--> markers) only when allowed. */
function fill(text, cfg) {
  text = text.replace(/<!--screen-->([\s\S]*?)<!--\/screen-->\n?/g, (_, inner) => (cfg.screenControl ? inner : ''));
  return text.replaceAll('{{SCRIPTS}}', paths.scripts).replaceAll('{{HONORIFIC}}', cfg.honorific).replaceAll('{{HOME}}', C.HOME)
    .replaceAll('{{ROOT}}', paths.root).replaceAll('{{STATE}}', C.STATE_DIR);
}

/** Instructions for the background agents the Claude Code brain starts. */
function agentPrompt(cfg) {
  let text;
  try { text = fs.readFileSync(path.join(paths.prompts, 'agent.md'), 'utf8'); } catch { text = 'Do the task fully, then end with one short paragraph starting with RESULT:.'; }
  return fill(text, cfg);
}

/** System prompt with placeholders filled and the memory file appended. */
function systemPrompt(cfg, extra = '') {
  let text;
  try { text = fs.readFileSync(path.join(paths.prompts, 'system.md'), 'utf8'); } catch { text = 'You are JARVIS, a concise spoken assistant.'; }
  text = fill(text, cfg);
  if (cfg.userName) text += `\n\nThe user's name is ${cfg.userName}.`;
  if (extra) text += '\n\n' + extra;
  const mem = new (require('../memory').Memory)().promptText();
  if (mem) text += `\n\nWHAT YOU KNOW ABOUT THE USER (from memory; use it naturally, never recite it):\n${mem}`;
  return text;
}

function summarise(name, input = {}) {
  const cut = (s) => String(s || '').slice(0, 90);
  switch (name) {
    case 'Bash': return cut(String(input.command || '').replaceAll(paths.scripts + '/', ''));
    case 'run_script': return cut(`${input.script || ''} ${(input.args || []).join(' ')}`);
    case 'Read': case 'Glob': case 'Grep': case 'read_file': return cut(input.file_path || input.pattern || input.path);
    case 'WebSearch': return cut(input.query);
    case 'WebFetch': case 'web_fetch': return cut(input.url);
    case 'open': return cut(input.target);
    case 'Agent': case 'Task': return cut(`agent: ${input.description || input.prompt || ''}`);
    default: return cut(JSON.stringify(input));
  }
}

module.exports = { SentenceSplitter, systemPrompt, agentPrompt, summarise };
