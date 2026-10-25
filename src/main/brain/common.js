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

/**
 * System prompt with placeholders filled and the memory file appended.
 * file: system.md for capable models, local.md (shorter) for small local ones.
 * worker: keep the parts between <!--worker--> markers (FRIDAY is available).
 */
function systemPrompt(cfg, extra = '', { file = 'system.md', worker = false } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(paths.prompts, file), 'utf8'); } catch { text = 'You are JARVIS, a concise spoken assistant.'; }
  text = fill(text, cfg).replace(/<!--worker-->([\s\S]*?)<!--\/worker-->\n?/g, (_, inner) => (worker ? inner : ''));
  if (cfg.userName) text += `\n\nThe user's name is ${cfg.userName}.`;
  if (extra) text += '\n\n' + extra;
  const mem = new (require('../memory').Memory)().promptText();
  if (mem) text += `\n\nWHAT YOU KNOW ABOUT THE USER (from memory; use it naturally, never recite it):\n${mem}`;
  return text;
}

/** Claude Code settings for the brain and FRIDAY: the user's deny rules and PreToolUse hooks, plus ours. */
function claudeSettings() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(`${C.HOME}/.claude/settings.json`, 'utf8')); } catch {}
  const deny = Array.isArray(user.permissions && user.permissions.deny) ? [...user.permissions.deny] : [];
  // Path rules only take effect as Edit(...); they cover Write as well.
  deny.push(`Edit(/${C.HOME}/.claude/**)`, `Edit(/${paths.root}/**)`, `Edit(/${C.STATE_DIR}/config.json)`);
  const out = { permissions: { deny } };
  if (user.hooks && Array.isArray(user.hooks.PreToolUse)) out.hooks = { PreToolUse: user.hooks.PreToolUse };
  return JSON.stringify(out);
}

/** Tools Claude Code may not use: new terminals only come from the user, and screen control only when allowed. */
function claudeDisallowed(cfg) {
  return `Bash(${paths.scripts}/open-session.sh*),Bash(*open-session.sh*)` + (cfg.screenControl ? '' : ',Bash(*hands.sh*),Bash(*jarvis-hands*)');
}

function summarise(name, input = {}) {
  const cut = (s) => String(s || '').slice(0, 90);
  switch (name) {
    case 'Bash': return cut(String(input.command || '').replaceAll(paths.scripts + '/', ''));
    case 'run_script': return cut(`${input.script || ''} ${[].concat(input.args || []).join(' ')}`);
    case 'Read': case 'Glob': case 'Grep': case 'read_file': return cut(input.file_path || input.pattern || input.path);
    case 'WebSearch': return cut(input.query);
    case 'WebFetch': case 'web_fetch': return cut(input.url);
    case 'open': return cut(input.target);
    case 'Agent': case 'Task': return cut(`agent: ${input.description || input.prompt || ''}`);
    case 'delegate': return cut(`agent: ${input.description || input.task || ''}`);
    default: return cut(JSON.stringify(input));
  }
}

module.exports = { SentenceSplitter, systemPrompt, agentPrompt, summarise, claudeSettings, claudeDisallowed };
