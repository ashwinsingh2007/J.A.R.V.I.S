// The API brain's conversation history, with fetch replaced by a fake server:
// no network and no real keys.
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
const ApiBrain = require('../../src/main/brain/api-brain');

const cfg = { ...C.DEFAULTS, anthropicApiKey: 'test-key' };
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
const toolUseReply = () => sse([
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'web_fetch' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://example.com"}' } },
  { type: 'content_block_stop', index: 0 },
]);
const textReply = (text) => sse([
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
]);

// The API rejects a request where a tool_use is not answered by a tool_result in the next message.
function assertToolUseAnswered(messages) {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content.filter((x) => x.type === 'tool_use')) {
      const next = messages[i + 1];
      const answered = next && Array.isArray(next.content) && next.content.some((x) => x.type === 'tool_result' && x.tool_use_id === b.id);
      assert.ok(answered, `tool_use ${b.id} has no tool_result after it`);
    }
  });
}

test('a turn cancelled while a tool runs leaves a history the API accepts', async (t) => {
  const brain = new ApiBrain(cfg, 'anthropic');
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://example.com')) {
      brain.cancel();     // the user speaks up while the page is loading
      return new Response('page', { headers: { 'content-type': 'text/plain' } });
    }
    const body = JSON.parse(opts.body);
    sent.push(body.messages);
    return sent.length === 1 ? toolUseReply() : textReply('Done, sir.');
  });

  await brain.ask('read example.com');
  const done = new Promise((r) => brain.once('done', (text, isError) => r({ text, isError })));
  await brain.ask('never mind, what time is it?');
  assertToolUseAnswered(sent[1]);
  assert.deepEqual(sent[1].map((m) => m.content), ['read example.com', 'never mind, what time is it?']);
  assert.deepEqual(await done, { text: 'Done, sir.', isError: false });
});

test('a request that fails after a tool round leaves a history the API accepts', async (t) => {
  const brain = new ApiBrain(cfg, 'anthropic');
  brain.reset();
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://example.com')) return new Response('page', { headers: { 'content-type': 'text/plain' } });
    sent.push(JSON.parse(opts.body).messages);
    if (sent.length === 1) return toolUseReply();
    if (sent.length === 2) return new Response('overloaded', { status: 529 });
    return textReply('Here you are.');
  });

  await brain.ask('read example.com');
  assert.equal(brain.history.length, 0);
  await brain.ask('try again');
  assertToolUseAnswered(sent[2]);
  assert.deepEqual(sent[2], [{ role: 'user', content: 'try again' }]);
});

test('the Gemini brain runs a tool call and speaks the answer', async (t) => {
  const brain = new ApiBrain({ ...C.DEFAULTS, geminiApiKey: 'test-key' }, 'gemini');
  brain.reset();
  const sent = [];
  const chunks = (list) => new Response(list.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://example.com')) return new Response('Example Domain', { headers: { 'content-type': 'text/plain' } });
    assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/);
    assert.equal(opts.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(opts.body);
    sent.push(body);
    if (sent.length === 1) return chunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"https://example.com"}' } }] } }] },
    ]);
    return chunks([{ choices: [{ delta: { content: 'It is the example page, sir.' } }] }]);
  });
  const done = new Promise((r) => brain.once('done', (text, isError) => r({ text, isError })));
  await brain.ask('what is on example.com?');
  assert.deepEqual(await done, { text: 'It is the example page, sir.', isError: false });
  assert.equal(sent[0].model, 'gemini-flash-latest');
  assert.equal(sent[0].messages[0].role, 'system');
  assert.ok(sent[0].tools.some((x) => x.function.name === 'web_fetch'));
  const second = sent[1].messages.slice(1);
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.equal(second[1].tool_calls[0].function.arguments, '{"url":"https://example.com"}');
  assert.equal(second[2].tool_call_id, 'c1');
  assert.match(second[2].content, /Example Domain/);
});

test('brain choice: Gemini comes after Claude Code and the Anthropic API, before Ollama', () => {
  const { choose } = require('../../src/main/brain');
  const none = { claude: { path: null, loggedIn: false } };
  const cc = { claude: { path: '/x/claude', loggedIn: true } };
  const base = { ...C.DEFAULTS, brainProvider: 'auto' };
  assert.equal(choose({ ...base, geminiApiKey: 'g' }, none), 'gemini');
  assert.equal(choose({ ...base, geminiApiKey: 'g', anthropicApiKey: 'a' }, none), 'anthropic');
  assert.equal(choose({ ...base, geminiApiKey: 'g' }, cc), 'claude-code');
  assert.equal(choose(base, none), 'ollama');
  assert.equal(choose({ ...base, brainProvider: 'gemini', geminiApiKey: 'g' }, cc), 'gemini');
});

test('a local brain hands a heavy job to FRIDAY, stops there, and retells her report without tools', async (t) => {
  const EventEmitter = (await import('node:events')).default;
  const worker = new EventEmitter();
  const jobs = [];
  worker.start = (description, task) => { jobs.push({ description, task }); return `Started. FRIDAY is ${description}.`; };
  const brain = new ApiBrain({ ...C.DEFAULTS, worker: 'claude-code' }, 'ollama', worker);
  brain.reset();
  const bodies = [];
  const nd = (objs) => new Response(objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (bodies.length === 1) return nd([{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'delegate', arguments: { description: 'checking your Gmail', task: 'Check Gmail.' } } }] }, done: true }]);
    return nd([{ message: { role: 'assistant', content: 'Two emails need a reply, sir.' }, done: true }]);
  });
  let done = new Promise((r) => brain.once('done', (text) => r(text)));
  await brain.ask('check my gmail and tell me what needs a reply');
  assert.equal(await done, '');
  assert.equal(bodies.length, 1, 'no second round after the handoff');
  assert.ok(bodies[0].tools.some((x) => x.function.name === 'delegate'));
  assert.equal(bodies[0].options.num_ctx, 8192);
  assert.match(bodies[0].messages[0].content, /TASKS → delegate/);
  assert.equal(jobs[0].description, 'checking your Gmail');
  assert.match(jobs[0].task, /The user's own words: "check my gmail and tell me what needs a reply"/);
  done = new Promise((r) => brain.once('done', (text) => r(text)));
  await brain.ask('[FRIDAY REPORT] FRIDAY finished "checking your Gmail".\n\nRESULT (done): two emails need a reply.');
  assert.equal(await done, 'Two emails need a reply, sir.');
  assert.equal(bodies[1].tools, undefined, 'retelling a report has no tools');
});

test('with FRIDAY switched off, a local brain gets no delegate tool and the short prompt has no worker section', async (t) => {
  const EventEmitter = (await import('node:events')).default;
  const brain = new ApiBrain({ ...C.DEFAULTS, worker: 'off' }, 'ollama', new EventEmitter());
  brain.reset();
  let body;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { body = JSON.parse(opts.body); return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Four.' }, done: true }) + '\n'); });
  await brain.ask('what is two plus two');
  assert.ok(!body.tools.some((x) => x.function.name === 'delegate'));
  assert.doesNotMatch(body.messages[0].content, /TASKS → delegate/);
});
