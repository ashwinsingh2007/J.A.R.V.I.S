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
const { assistantOf } = require('../assistants');

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
    .replaceAll('{{ROOT}}', paths.root).replaceAll('{{STATE}}', C.STATE_DIR)
    .replaceAll('{{NAME}}', assistantOf(cfg.assistant, cfg).name).replaceAll('{{PERSONA}}', assistantOf(cfg.assistant, cfg).persona);
}

function read(file, fallback) {
  try { return fs.readFileSync(path.join(paths.prompts, file), 'utf8'); } catch { return fallback; }
}

/**
 * What makes this assistant its own: its guardrails, its role, the quick commands the user gave it, and
 * the tools switched off for it. The safety rules above always win.
 */
function agentBlock(cfg) {
  const { assistantOf, roleFocus, toolsOff, TOOLS, GUARDS } = require('../assistants');
  const a = assistantOf(cfg.assistant, cfg);
  let out = '';
  const guard = (GUARDS[a.guard] || {}).rule;
  if (guard) out += `\n\n${guard}`;
  if ((a.blockedPaths || []).length) out += `\n\nGUARDRAIL: never open, read, list, search or change anything in these folders, with any tool or command: ${a.blockedPaths.join(', ')}. If a task needs them, say they are off limits for you.`;
  const focus = roleFocus(a);
  if (focus) out += `\n\nYOUR ROLE: ${focus} This is your focus, not a limit: you still do anything the user asks. Anything that sends, posts or replies to someone still needs the user's yes first.`;
  const cmds = (a.commands || []).filter((c) => c && c.name && c.prompt);
  if (cmds.length) out += `\n\nQUICK COMMANDS the user set up for you. When they say or type one (with or without a slash), do what it says:\n${cmds.map((c) => `- "${c.name}": ${c.prompt}`).join('\n')}`;
  const off = toolsOff(a);
  if (off.length) out += `\n\nSWITCHED OFF FOR YOU (the user can turn them on in the Agents tab): ${off.map((t) => TOOLS[t].label.toLowerCase()).join('; ')}. Don't try them; if a task needs one, say so in one sentence.`;
  return out;
}

/** Instructions for the background worker, with what the assistant knows about the user. */
function workerPrompt(cfg) {
  let text = fill(read('worker.md', 'Do the task fully, then end with one short paragraph starting with RESULT:.'), cfg);
  if (cfg.userName) text += `\n\nThe user's name is ${cfg.userName}.`;
  text += agentBlock(cfg);
  text += require('../memory').promptFor(cfg, 'use it in your work, never recite it');
  return text;
}

/**
 * System prompt with placeholders filled and the memory file appended.
 * file: system.md for capable models, local.md (shorter) for small local ones.
 * worker: keep the parts between <!--worker--> markers (the background worker is available).
 */
function systemPrompt(cfg, extra = '', { file = 'system.md', worker = false } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(paths.prompts, file), 'utf8'); } catch { text = 'You are {{NAME}}, a concise spoken assistant.'; }
  text = fill(text, cfg).replace(/<!--worker-->([\s\S]*?)<!--\/worker-->\n?/g, (_, inner) => (worker ? inner : ''));
  if (cfg.userName) text += `\n\nThe user's name is ${cfg.userName}.`;
  text += agentBlock(cfg);
  if (extra) text += '\n\n' + extra;
  text += require('../memory').promptFor(cfg);
  return text;
}

/**
 * Claude Code settings for the brain and its worker: the user's deny rules and PreToolUse hooks, plus
 * ours, plus the claude.ai connectors this assistant may not use.
 */
function claudeSettings(cfg) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(`${C.HOME}/.claude/settings.json`, 'utf8')); } catch {}
  const deny = Array.isArray(user.permissions && user.permissions.deny) ? [...user.permissions.deny] : [];
  // Path rules only take effect as Edit(...); they cover Write as well.
  deny.push(`Edit(/${C.HOME}/.claude/**)`, `Edit(/${paths.root}/**)`, `Edit(/${C.STATE_DIR}/config.json)`);
  if (cfg) deny.push(...require('../mcp').denyFor(cfg));
  // This assistant's tools and guardrails, folders it may not open included.
  if (cfg && cfg.assistant) { const { assistantOf, denyRules } = require('../assistants'); deny.push(...denyRules(assistantOf(cfg.assistant, cfg))); }
  const out = { permissions: { deny } };
  if (user.hooks && Array.isArray(user.hooks.PreToolUse)) out.hooks = { PreToolUse: user.hooks.PreToolUse };
  return JSON.stringify(out);
}

/** The assistant's own skills (a plugin of links) and MCP servers, for a Claude Code process. */
function claudeExtras(cfg) {
  const plugin = require('../skills').pluginFor(cfg);
  const mcp = require('../mcp').configFor(cfg);
  return [...(plugin ? ['--plugin-dir', plugin] : []), ...(mcp ? ['--mcp-config', mcp] : [])];
}

/**
 * Tools Claude Code may not use: new terminals only come from the user, and screen control only when allowed.
 * The brain also has no web search: searching is the worker's job, so JARVIS hands it over instead.
 */
function claudeDisallowed(cfg, { brain = false } = {}) {
  const { assistantOf, denyRules } = require('../assistants');
  // Path rules only hold as settings deny rules (claudeSettings), so they are left out here.
  const off = cfg.assistant ? denyRules(assistantOf(cfg.assistant, cfg)).filter((r) => !/^(Read|Edit)\(\//.test(r)) : [];
  return [`Bash(${paths.scripts}/open-session.sh*)`, 'Bash(*open-session.sh*)', ...(cfg.screenControl ? [] : ['Bash(*hands.sh*)', 'Bash(*jarvis-hands*)']),
    ...(brain ? ['WebSearch', 'WebFetch'] : []), ...off].filter((x, i, all) => all.indexOf(x) === i).join(',');
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

module.exports = { SentenceSplitter, systemPrompt, workerPrompt, agentBlock, summarise, claudeSettings, claudeExtras, claudeDisallowed, fill, read };
