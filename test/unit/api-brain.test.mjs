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
