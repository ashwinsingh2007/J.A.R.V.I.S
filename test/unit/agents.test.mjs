// Each agent's own setup: role, quick commands, tools, guardrails and its own memory, and how they reach
// the brain's prompt and its deny rules. A throwaway state folder, no real Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
process.env.HOME = HOME;
process.env.JARVIS_STATE_DIR = path.join(HOME, '.jarvis');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
require('../../src/main/util').initPaths(ROOT);
const A = require('../../src/main/assistants');
const { systemPrompt, workerPrompt, claudeSettings, claudeDisallowed } = require('../../src/main/brain/common');
const { Memory, ownFile, memoryEnv } = require('../../src/main/memory');
const tools = require('../../src/main/brain/tools');

const cfgFor = (id) => { C.save({ assistant: id }); return C.load(); };

test('the presets ship with a role, and KAREN handles communications', () => {
  assert.equal(A.assistantOf('karen', {}).role, 'communications');
  assert.equal(A.assistantOf('friday', {}).role, 'coding');
  assert.equal(A.assistantOf('jarvis', {}).role, 'none');
  const p = systemPrompt(cfgFor('karen'));
  assert.match(p, /YOUR ROLE: Your speciality is the user's communications/);
  assert.match(p, /not a limit/);
  assert.doesNotMatch(systemPrompt(cfgFor('jarvis')), /YOUR ROLE/);
});

test('a role, quick commands and a colour the user sets are kept and reach the prompt', () => {
  C.saveProfile('jarvis', { role: 'custom', roleText: 'Keeps my running plan on track.', commands: [{ name: 'standup', prompt: 'Tell me what my sessions did since yesterday.' }], color: '#ff8800' });
  const cfg = cfgFor('jarvis');
  const a = A.assistantOf('jarvis', cfg);
  assert.equal(a.color, '#ff8800');
  const p = systemPrompt(cfg);
  assert.match(p, /in the user's words: Keeps my running plan on track\./);
  assert.match(p, /"standup": Tell me what my sessions did since yesterday\./);
  assert.match(workerPrompt(cfg), /Keeps my running plan on track/);
  C.saveProfile('jarvis', { role: null, roleText: null, commands: null, color: null });
  assert.equal(A.assistantOf('jarvis', C.load()).role, 'none');
});

test('tools switched off and guardrails become deny rules for the brain and the worker', () => {
  C.saveProfile('friday', { tools: ['mac', 'files', 'screen', 'reminders', 'terminals'], guard: 'careful', blockedPaths: [path.join(HOME, 'Private')] });
  let cfg = cfgFor('friday');
  const off = claudeDisallowed(cfg);
  assert.match(off, /WebSearch/);
  assert.match(off, /mcp__claude-in-chrome/);
  assert.doesNotMatch(off, /Read\(/);
  const deny = JSON.parse(claudeSettings(cfg)).permissions.deny;
  assert.ok(deny.includes(`Read(/${path.join(HOME, 'Private')}/**)`));
  const p = systemPrompt(cfg);
  assert.match(p, /GUARDRAIL \(careful\)/);
  assert.match(p, /SWITCHED OFF FOR YOU.*web and your browser/);
  assert.match(p, /never open, read, list.*Private/);

  C.saveProfile('friday', { tools: null, guard: 'readonly', blockedPaths: null });
  cfg = cfgFor('friday');
  assert.match(claudeDisallowed(cfg), /Bash\(\*send\.sh\*\)/);
  assert.match(claudeDisallowed(cfg), /\bEdit\b/);
  C.saveProfile('friday', { guard: null });
  assert.doesNotMatch(claudeDisallowed(cfgFor('friday')), /send\.sh/);
});

test('the brain and the worker may not type to JARVIS through the jarvis command', () => {
  const off = claudeDisallowed(cfgFor('jarvis'));
  assert.match(off, /Bash\(jarvis \*\)/);
  assert.match(off, /Bash\(\*jarvis\.sock\*\)/);
});

test('the API brains refuse tools and folders an agent may not use', async () => {
  C.saveProfile('vision', { tools: ['browser', 'terminals', 'screen', 'files', 'reminders'], blockedPaths: [path.join(HOME, 'Private')] });
  const cfg = cfgFor('vision');
  assert.match(await tools.execute('run_script', { script: 'mac.sh', args: ['battery'] }, cfg), /switched off/);
  fs.mkdirSync(path.join(HOME, 'Private'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'Private', 'x.txt'), 'secret');
  assert.match(await tools.execute('read_file', { path: '~/Private/x.txt' }, cfg), /off limits/);
  C.saveProfile('vision', { tools: null, blockedPaths: null });
});

test('each agent has its own memory, and can stop reading the shared one', () => {
  new Memory().add('Lives in Bengaluru.');
  new Memory(ownFile('karen')).add('Signs off emails with "Cheers".');
  let cfg = cfgFor('karen');
  let p = systemPrompt(cfg);
  assert.match(p, /WHAT YOU KNOW ABOUT THE USER[\s\S]*Bengaluru/);
  assert.match(p, /YOUR OWN MEMORY[\s\S]*Cheers/);
  assert.doesNotMatch(systemPrompt(cfgFor('jarvis')), /Cheers/);

  C.saveProfile('karen', { sharedMemory: false });
  cfg = cfgFor('karen');
  p = systemPrompt(cfg);
  assert.doesNotMatch(p, /Bengaluru/);
  assert.match(p, /Cheers/);
  // memory.py, run from that brain, writes to its own memory.
  const out = execFileSync('/usr/bin/python3', ['-I', path.join(ROOT, 'scripts', 'memory.py'), 'add', 'Prefers short replies.'], { env: { ...process.env, ...memoryEnv(cfg) } }).toString();
  assert.match(out, /own/);
  assert.ok(new Memory(ownFile('karen')).facts.some((f) => f.text === 'Prefers short replies.'));
  assert.ok(!new Memory().facts.some((f) => f.text === 'Prefers short replies.'));
  C.saveProfile('karen', { sharedMemory: null });
});

test('EDITH maintains JARVIS: only a maintainer may work on its code, and never in the live checkout', () => {
  let cfg = cfgFor('edith');
  const a = A.assistantOf('edith', cfg);
  assert.ok(a.maintainer);
  assert.equal(a.role, 'maintainer');
  assert.equal(cfg.brainProvider, 'claude-code');
  assert.match(systemPrompt(cfg), /MAINTAINING JARVIS \(you are/);
  assert.match(workerPrompt(cfg), /maintain\.sh start/);
  let deny = JSON.parse(claudeSettings(cfg)).permissions.deny;
  assert.ok(deny.includes(`Edit(/${ROOT}/**)`), 'the live checkout stays blocked');
  assert.ok(!deny.some((r) => r.includes('/maintain/**')));
  assert.doesNotMatch(claudeDisallowed(cfg), /maintain\.sh/);

  cfg = cfgFor('jarvis');
  assert.doesNotMatch(systemPrompt(cfg), /MAINTAINING JARVIS \(you are/);
  deny = JSON.parse(claudeSettings(cfg)).permissions.deny;
  assert.ok(deny.includes(`Edit(/${process.env.JARVIS_STATE_DIR}/maintain/**)`));
  assert.match(claudeDisallowed(cfg), /Bash\(\*maintain\.sh\*\)/);

  // The user can make another agent a maintainer, or stop EDITH being one.
  C.saveProfile('jarvis', { maintainer: true });
  assert.match(systemPrompt(cfgFor('jarvis')), /MAINTAINING JARVIS \(you are/);
  C.saveProfile('jarvis', { maintainer: null });
});

test('maintain.sh only works in its own worktrees, and a restart is a request JARVIS picks up', () => {
  const sh = path.join(ROOT, 'scripts', 'maintain.sh');
  const env = { ...process.env, JARVIS_STATE_DIR: process.env.JARVIS_STATE_DIR };
  assert.throws(() => execFileSync('/bin/sh', [sh, 'check', ROOT], { env, stdio: 'pipe' }), /not a maintenance worktree/);
  assert.throws(() => execFileSync('/bin/sh', [sh, 'finish', os.tmpdir()], { env, stdio: 'pipe' }), /not a maintenance worktree/);
  execFileSync('/bin/sh', [sh, 'restart', 'a "test" update'], { env });
  const req = JSON.parse(fs.readFileSync(path.join(process.env.JARVIS_STATE_DIR, 'restart-request.json'), 'utf8'));
  assert.equal(req.reason, 'a test update');
});
