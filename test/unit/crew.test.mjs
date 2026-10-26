// The crew: each member's instructions, and the API brain handing jobs to the right one.
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
const { CREW, agentPrompt, systemPrompt, claudeDisallowed } = require('../../src/main/brain/common');
const ApiBrain = require('../../src/main/brain/api-brain');

test('each crew member gets their own persona, the shared rules and the crew list', () => {
  for (const id of CREW) {
    const p = agentPrompt(C.DEFAULTS, id);
    assert.match(p, new RegExp(`^You are ${id.toUpperCase()}`));
    assert.match(p, /RESULT \(done\)/);
    assert.match(p, /HANDOFF <NAME>/);
    assert.match(p, /THE CREW/);
    assert.doesNotMatch(p, /\{\{/);
  }
  assert.match(agentPrompt(C.DEFAULTS, 'nobody'), /^You are FRIDAY/);
});

test('the brain prompt describes the crew, and the Claude Code brain has no web search of its own', () => {
  const p = systemPrompt(C.DEFAULTS);
  assert.match(p, /KAREN: communication/);
  assert.match(p, /subagent_type \("friday", "karen", "edith" or "vision"\)/);
  assert.match(claudeDisallowed(C.DEFAULTS, { brain: true }), /WebSearch,WebFetch/);
  assert.doesNotMatch(claudeDisallowed(C.DEFAULTS), /WebSearch/);
});

test('delegate goes to the crew member the brain names, and a handover report keeps only delegate', async (t) => {
  const worker = new EventEmitter();
  const jobs = [];
  worker.start = (description, task, agent) => { jobs.push({ description, task, agent }); return 'Started.'; };
  const brain = new ApiBrain({ ...C.DEFAULTS, worker: 'claude-code' }, 'ollama', worker);
  brain.reset();
  const bodies = [];
  const nd = (o) => new Response(JSON.stringify(o) + '\n');
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return nd({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'delegate', arguments: { to: 'karen', description: 'drafting a LinkedIn post', task: 'Draft a post.' } } }] }, done: true });
    return nd({ message: { role: 'assistant', content: 'Done, sir.' }, done: true });
  });
  let done = new Promise((r) => brain.once('done', r));
  await brain.ask('draft a linkedin post about my new project');
  await done;
  assert.equal(jobs[0].agent, 'karen');
  done = new Promise((r) => brain.once('done', r));
  await brain.ask('[EDITH REPORT] EDITH finished "reviewing the code".\n\nRESULT (done): one bug.\nHANDOFF FRIDAY: fix the bug in pay.js');
  await done;
  assert.deepEqual(bodies[1].tools.map((x) => x.function.name), ['delegate']);
});
