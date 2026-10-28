// The MCP servers an assistant can use.
//
// Two kinds: the user's own servers, set up for their Claude Code (user scope, in ~/.claude.json), and
// their claude.ai connectors (Gmail, Drive, Slack…), which Claude Code brings in by itself. The brain
// starts without the user's Claude settings, so their own servers are passed in with --mcp-config;
// connectors an assistant shouldn't use are blocked with deny rules, which hold in bypass mode too.
//
// An assistant's choice is cfg.assistantSettings[id].mcp: a list of server names, or none for all.
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { log, run, findClaude } = require('./util');

const CLAUDE_JSON = path.join(C.HOME, '.claude.json');
const STATUS_FILE = path.join(C.STATE_DIR, 'mcp-status.json');

/** The user's own servers: { name: definition }. */
function own() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).mcpServers || {}; } catch { return {}; }
}

/** The last health check: [{ name, target, status }], connectors included. */
function lastStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return []; }
}

/** Every server an assistant can use, with its last known status. */
function list() {
  const status = Object.fromEntries(lastStatus().map((s) => [s.name, s]));
  const mine = Object.entries(own()).map(([name, d]) => ({ name, kind: 'server', target: d.url || [d.command, ...(d.args || [])].join(' '), status: (status[name] || {}).status || 'unknown' }));
  const connectors = lastStatus().filter((s) => s.name.startsWith('claude.ai ')).map((s) => ({ name: s.name, kind: 'connector', target: s.target, status: s.status }));
  return [...mine, ...connectors];
}

const claude = () => findClaude() || 'claude';

/** `claude mcp list`: connects to each server, so it takes a few seconds. */
async function check() {
  const r = await run(claude(), ['mcp', 'list'], { timeout: 60000, cwd: C.HOME });
  const out = [];
  for (const line of r.out.split('\n')) {
    const m = /^(.+?): (.+) - (.+)$/.exec(line.trim());
    if (!m) continue;
    const st = /connected/i.test(m[3]) ? 'connected' : /auth/i.test(m[3]) ? 'needs sign-in' : /pending/i.test(m[3]) ? 'pending' : 'failed';
    out.push({ name: m[1], target: m[2].replace(/ \(HTTP\)$/, ''), status: st });
  }
  if (out.length) try { fs.writeFileSync(STATUS_FILE, JSON.stringify(out), { mode: 0o600 }); } catch {}
  log(`mcp: ${out.length} server(s), ${out.filter((s) => s.status === 'connected').length} connected`);
  return list();
}

function chosen(cfg, id) {
  const pick = ((cfg.assistantSettings || {})[id] || {}).mcp;
  return Array.isArray(pick) ? pick : null;
}

/** --mcp-config for the assistant: its own servers that it may use, or '' for none. */
function configFor(cfg, id = cfg.assistant) {
  const pick = chosen(cfg, id);
  const servers = Object.fromEntries(Object.entries(own()).filter(([name]) => !pick || pick.includes(name)));
  return Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }) : '';
}

/** Deny rules for the connectors the assistant may not use. */
function denyFor(cfg, id = cfg.assistant) {
  const pick = chosen(cfg, id);
  if (!pick) return [];
  return lastStatus().filter((s) => s.name.startsWith('claude.ai ') && !pick.includes(s.name))
    .map((s) => `mcp__${s.name.replace(/[^A-Za-z0-9]+/g, '_')}`);
}

/** A new server for the user's Claude Code: an https URL, or a command that starts it. */
async function add(name, target) {
  name = String(name || '').trim();
  target = String(target || '').trim();
  if (!/^[\w.-]{1,40}$/.test(name)) return 'Give it a short name: letters, numbers, dots and dashes.';
  if (own()[name]) return `There is already a server called ${name}.`;
  const args = /^https?:\/\//.test(target)
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, target]
    : ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', name, '--', ...(target.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))];
  if (args[args.length - 1] === '--') return 'Give the server address or the command that starts it.';
  log(`mcp: adding ${name}`);
  const r = await run(claude(), args, { timeout: 30000, cwd: C.HOME });
  return r.code === 0 ? '' : (r.err || r.out).trim().slice(0, 240);
}

async function remove(name) {
  if (!own()[name]) return 'Only your own servers can be removed here.';
  log(`mcp: removing ${name}`);
  const r = await run(claude(), ['mcp', 'remove', '--scope', 'user', name], { timeout: 30000, cwd: C.HOME });
  return r.code === 0 ? '' : (r.err || r.out).trim().slice(0, 240);
}

module.exports = { list, check, configFor, denyFor, add, remove, chosen };
