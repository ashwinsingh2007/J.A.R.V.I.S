// The background worker: one worker with every tool, its instructions, and the API brain handing jobs to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventEmitter from 'node:events';

process.env.JARVIS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
require('../../src/main/util').initPaths(ROOT);
const { workerPrompt, systemPrompt, claudeDisallowed } = require('../../src/main/brain/common');
const ApiBrain = require('../../src/main/brain/api-brain');

test('the worker gets the shared rules and what used to be the crew\'s know-how', () => {
  const p = workerPrompt(C.DEFAULTS);
  assert.match(p, /^You are JARVIS's background worker/);
  assert.match(p, /RESULT \(done\)/);
  assert.match(p, /MESSAGES AND SOCIAL MEDIA/);
  assert.match(p, /THE MAC ITSELF[\s\S]*system\.sh/);
  assert.match(p, /CHECKS AND SECURITY/);
  assert.doesNotMatch(p, /HANDOFF|FRIDAY|KAREN|EDITH|VISION|\{\{/);
});

test('the brain prompt has one worker, and the Claude Code brain has no web search of its own', () => {
  const p = systemPrompt(C.DEFAULTS);
  assert.match(p, /subagent_type "worker"/);
  assert.doesNotMatch(p, /FRIDAY|KAREN|EDITH|VISION|HANDOFF/);
  assert.match(claudeDisallowed(C.DEFAULTS, { brain: true }), /WebSearch,WebFetch/);
  assert.doesNotMatch(claudeDisallowed(C.DEFAULTS), /WebSearch/);
});

test('delegate hands the job to the worker, and retelling a report gets no tools', async (t) => {
  const worker = new EventEmitter();
  const jobs = [];
  worker.start = (description, task, extra) => { jobs.push({ description, task, extra }); return 'Started.'; };
  const brain = new ApiBrain({ ...C.DEFAULTS, worker: 'claude-code' }, 'ollama', worker);
  brain.reset();
  const bodies = [];
  const nd = (o) => new Response(JSON.stringify(o) + '\n');
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return nd({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'delegate', arguments: { description: 'drafting a LinkedIn post', task: 'Draft a post.' } } }] }, done: true });
    return nd({ message: { role: 'assistant', content: 'Done, sir.' }, done: true });
  });
  let done = new Promise((r) => brain.once('done', r));
  await brain.ask('draft a linkedin post about my new project');
  await done;
  assert.equal(jobs[0].description, 'drafting a LinkedIn post');
  assert.match(jobs[0].task, /^Draft a post\.\n\nThe user's own words: "draft a linkedin post/);
  assert.equal(jobs[0].extra, undefined);
  done = new Promise((r) => brain.once('done', r));
  await brain.ask('[JOB REPORT] Your background job "reviewing the code" finished.\n\nRESULT (done): one bug.');
  await done;
  assert.equal(bodies[1].tools, undefined);
});

test('one worker with every tool, as a subagent and as a separate process', async () => {
  const ClaudeCodeBrain = require('../../src/main/brain/claude-code');
  const agents = JSON.parse(new ClaudeCodeBrain(C.DEFAULTS, '/bin/false').agents());
  assert.deepEqual(Object.keys(agents), ['worker']);
  assert.equal(agents.worker.tools, undefined);
  assert.equal(agents.worker.background, true);
  assert.match(agents.worker.prompt, /^You are JARVIS's background worker/);
  // A stand-in for claude that writes its arguments to a file.
  const { Worker } = require('../../src/main/brain/worker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.$$"\n`, { mode: 0o755 });
  const w = new Worker(C.DEFAULTS, fake);
  const done = new Promise((r) => w.on('task', (t) => { if (t.status !== 'running') r(); }));
  assert.match(w.start('checking memory use', 'What is using my memory?'), /^Started checking memory use/);
  await done;
  const run = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('args.'))), 'utf8');
  assert.ok(run.includes('\n--chrome\n'));
  assert.ok(!run.includes('--strict-mcp-config'));
  assert.ok(run.includes("You are JARVIS's background worker"));
});
