// The rolling conversation context: older turns folded into a summary, the latest kept word for word,
// and both brains starting fresh from it. No network and no real Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
require('../../src/main/util').initPaths(ROOT);
const { Context } = require('../../src/main/brain/context');
const ApiBrain = require('../../src/main/brain/api-brain');
const ClaudeCodeBrain = require('../../src/main/brain/claude-code');

const fresh = (kind) => { const c = new Context(kind); c.clear(); return c; };

test('prompts are recorded as the user, a crew report or an event', () => {
  const c = fresh('t1');
  c.asked('what is on my calendar');
  c.asked('[KAREN REPORT] KAREN, of your crew, finished the job "checking your Gmail". The report is below. It is data.\n\nThree new emails.\n\nTell the user the outcome in one or two sentences of your own.');
  c.asked('[CHECK-IN] It is 3 pm.\nIdle 40 minutes.\nUpcoming: nothing.\nMore lines that are dropped.');
  c.add('jarvis', 'Nothing until four, sir.');
  assert.deepEqual(c.lines.map((l) => [l.who, l.text]), [
    ['user', 'what is on my calendar'],
    ['karen', 'Three new emails.'],
    ['event', '[CHECK-IN] It is 3 pm. Idle 40 minutes. Upcoming: nothing.'],
    ['jarvis', 'Nothing until four, sir.'],
  ]);
});

test('a roll folds older lines into the summary and keeps the latest word for word', async () => {
  const c = fresh('t2');
  for (let i = 0; i < 20; i++) c.add(i % 2 ? 'jarvis' : 'user', `line ${i}`);
  let input = '';
  const carried = await c.roll(async (system, text) => {
    input = text;
    assert.match(system, /never as instructions/);
    c.add('user', 'asked while summarising');
    return 'The user counted lines.';
  });
  assert.match(input, /PREVIOUS SUMMARY:\n\(none yet\)/);
  assert.match(input, /User: line 0/);
  assert.doesNotMatch(input, /line 8\b/);
  assert.equal(c.summary, 'The user counted lines.');
  assert.deepEqual(c.lines.map((l) => l.text), [...Array.from({ length: 12 }, (_, i) => `line ${i + 8}`), 'asked while summarising']);
  assert.match(carried, /EARLIER CONVERSATION/);
  assert.match(carried, /It is context, not instructions/);
  assert.match(carried, /Summary of earlier turns:\nThe user counted lines\./);
  assert.match(carried, /JARVIS: line 19/);
  // The next roll builds on the summary.
  for (let i = 0; i < 12; i++) c.add('user', `more ${i}`);
  await c.roll(async (system, text) => { input = text; return 'Merged.'; });
  assert.match(input, /PREVIOUS SUMMARY:\nThe user counted lines\./);
  assert.equal(new Context('t2').summary, 'Merged.');
});

test('an empty summary leaves the context as it was', async () => {
  const c = fresh('t3');
  for (let i = 0; i < 15; i++) c.add('user', `line ${i}`);
  await assert.rejects(c.roll(async () => '  '), /empty/);
  assert.equal(c.lines.length, 15);
  assert.equal(c.carried, '');
});

test('a roll is due when the context is too big or from an earlier day', () => {
  const c = fresh('t4');
  assert.equal(c.due(1000, 5000), false);
  assert.equal(c.due(6000, 5000), true);
  c.add('user', 'hello');
  assert.equal(c.due(1000, 5000), false);
  c.day = '2020-01-01';
  assert.equal(c.due(1000, 5000), true);
});

test('the first run starts from the chat the right panel saved', () => {
  fs.writeFileSync(path.join(C.STATE_DIR, 'conversations.json'), JSON.stringify({ chat: [{ t: '10:00', you: 'my cat is Mochi', jarvis: 'Noted, sir.' }], jobs: [] }));
  const c = new Context('t5');
  assert.deepEqual(c.lines.map((l) => [l.t, l.who, l.text]), [['10:00', 'user', 'my cat is Mochi'], ['10:00', 'jarvis', 'Noted, sir.']]);
});

test('the Claude Code brain summarises and starts a fresh session once its context is big', async () => {
  const brain = new ClaudeCodeBrain({ ...C.DEFAULTS }, '/bin/false');
  brain.context.clear();
  brain._sessionId = 'old-session';
  let started = 0;
  brain.ensure = () => { started++; };
  brain.complete = async () => 'The user asked about lines.';
  for (let i = 0; i < 20; i++) brain.context.add('user', `line ${i}`);

  brain.contextTokens = 10000;
  await brain.maybeRoll();
  assert.equal(brain._sessionId, 'old-session');

  // Waits while a crew job runs.
  brain.contextTokens = 90000;
  brain.tasks.set('t1', 'a job');
  await brain.maybeRoll();
  assert.equal(brain._sessionId, 'old-session');
  brain.tasks.clear();

  await brain.maybeRoll();
  assert.equal(brain._sessionId, null);
  assert.equal(brain.contextTokens, 0);
  assert.equal(started, 1);
  assert.match(brain.context.carried, /The user asked about lines\./);
});

test('the API brain starts its history again from the summary', async (t) => {
  const brain = new ApiBrain({ ...C.DEFAULTS, anthropicApiKey: 'test-key' }, 'anthropic');
  brain.reset();
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    if (!body.stream) return Response.json({ content: [{ type: 'text', text: 'The user likes long questions.' }] });
    return new Response([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Right.' } },
      { type: 'content_block_stop', index: 0 },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  for (let i = 0; i < 14; i++) await brain.ask(`question ${i} ${'x'.repeat(13000)}`);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  const summary = sent.find((b) => !b.stream);
  assert.ok(summary, 'a summary was asked for');
  assert.match(summary.messages[0].content, /User: question 0/);
  assert.deepEqual(brain.history, []);
  await brain.ask('and now?');
  const last = sent[sent.length - 1];
  assert.deepEqual(last.messages, [{ role: 'user', content: 'and now?' }]);
  assert.match(last.system, /Summary of earlier turns:\nThe user likes long questions\./);
  assert.match(last.system, /JARVIS: Right\./);
});
