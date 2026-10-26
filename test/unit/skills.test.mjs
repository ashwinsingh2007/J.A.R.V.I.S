// Skills and MCP servers per assistant: what's found on the Mac, the plugin of links each assistant
// gets, its --mcp-config and the deny rules for connectors. A throwaway home folder, no real Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
process.env.HOME = HOME;
process.env.JARVIS_STATE_DIR = path.join(HOME, '.jarvis');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
require('../../src/main/util').initPaths(ROOT);
const skills = require('../../src/main/skills');
const mcp = require('../../src/main/mcp');
const { claudeSettings, claudeExtras } = require('../../src/main/brain/common');

const skill = (dir, name, desc) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: |\n  ${desc}\n  More words.\n---\n\nBody.\n`);
};
skill(path.join(HOME, '.claude/skills/humanizer'), 'humanizer', 'Rewrite AI-sounding text.');
skill(path.join(HOME, '.claude/skills/position-sizer'), 'position-sizer', 'Size a trade.');
const plug = path.join(HOME, '.claude/plugins/cache/m/frames/1.0');
skill(path.join(plug, 'skills/frames-core'), 'frames-core', 'Make video frames.');
fs.writeFileSync(path.join(HOME, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'frames@m': [{ scope: 'user', installPath: plug }] } }));
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['notes.js'] }, meet: { type: 'http', url: 'https://meet.example/mcp' } } }));
fs.mkdirSync(process.env.JARVIS_STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JARVIS_STATE_DIR, 'mcp-status.json'), JSON.stringify([
  { name: 'notes', target: 'node notes.js', status: 'connected' },
  { name: 'claude.ai Gmail', target: 'https://gmail', status: 'connected' },
  { name: 'claude.ai Google Drive', target: 'https://drive', status: 'needs sign-in' },
]));

test('skills are found in the user\'s folder and inside installed plugins', () => {
  const all = skills.catalog();
  assert.deepEqual(all.map((s) => [s.id, s.name, s.source]), [
    ['personal/humanizer', 'humanizer', 'personal'],
    ['personal/position-sizer', 'position-sizer', 'personal'],
    ['frames/frames-core', 'frames-core', 'plugin'],
  ]);
  assert.equal(all[0].description, 'Rewrite AI-sounding text. More words.');
});

test('each assistant gets a plugin of links to its own skills', () => {
  const cfg = { ...C.DEFAULTS, assistant: 'friday', assistantSettings: {} };
  let dir = skills.pluginFor(cfg);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), ['frames-frames-core', 'humanizer', 'position-sizer']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')).name, 'jarvis-friday');
  cfg.assistantSettings.friday = { skills: ['personal/humanizer'] };
  dir = skills.pluginFor(cfg);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['humanizer']);
  assert.equal(fs.realpathSync(path.join(dir, 'skills/humanizer')), fs.realpathSync(path.join(HOME, '.claude/skills/humanizer')));
  cfg.assistantSettings.friday = { skills: [] };
  assert.equal(skills.pluginFor(cfg), '');
});

test('each assistant gets its own MCP servers, and connectors it may not use are denied', () => {
  const cfg = { ...C.DEFAULTS, assistant: 'karen', assistantSettings: {} };
  assert.deepEqual(Object.keys(JSON.parse(mcp.configFor(cfg)).mcpServers), ['notes', 'meet']);
  assert.deepEqual(mcp.denyFor(cfg), []);
  cfg.assistantSettings.karen = { mcp: ['meet', 'claude.ai Gmail'] };
  assert.deepEqual(Object.keys(JSON.parse(mcp.configFor(cfg)).mcpServers), ['meet']);
  assert.deepEqual(mcp.denyFor(cfg), ['mcp__claude_ai_Google_Drive']);
  assert.ok(JSON.parse(claudeSettings(cfg)).permissions.deny.includes('mcp__claude_ai_Google_Drive'));
  const args = claudeExtras(cfg);
  assert.equal(args[0], '--plugin-dir');
  assert.equal(args[2], '--mcp-config');
  assert.deepEqual(mcp.list().map((m) => [m.name, m.kind, m.status]), [
    ['notes', 'server', 'connected'], ['meet', 'server', 'unknown'],
    ['claude.ai Gmail', 'connector', 'connected'], ['claude.ai Google Drive', 'connector', 'needs sign-in'],
  ]);
});

test('only skills added from GitHub can be removed here', () => {
  assert.match(skills.removeOwn('personal/humanizer'), /Only skills added here/);
  skill(path.join(process.env.JARVIS_STATE_DIR, 'skills/tidy'), 'tidy', 'Tidy up.');
  assert.ok(skills.catalog().some((s) => s.id === 'jarvis/tidy'));
  assert.equal(skills.removeOwn('jarvis/tidy'), '');
  assert.ok(!skills.catalog().some((s) => s.id === 'jarvis/tidy'));
});
