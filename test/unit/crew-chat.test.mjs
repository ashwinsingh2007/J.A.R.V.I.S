// Talking to a crew member directly: their own ongoing session, resumed for every message, with a
// stand-in for claude so nothing real runs.
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
const { CrewChat } = require('../../src/main/brain/crew-chat');
const { Conversations } = require('../../src/main/conversations');

// Writes its arguments to a file and answers like `claude -p --output-format stream-json`.
function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args.$(date +%s%N)"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-karen-1"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"STATUS: checking LinkedIn"}],"usage":{"input_tokens":5,"cache_read_input_tokens":20000}}}'
printf '%s\\n' '{"type":"result","result":"STATUS: checking LinkedIn\\nTwo new messages, sir. Shall I draft replies?\\n\\nRESULT: Two new messages.","session_id":"sess-karen-1"}'
`, { mode: 0o755 });
  const runs = () => fs.readdirSync(dir).filter((f) => f.startsWith('args.')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  return { fake, runs };
}
const reply = (chat) => new Promise((r) => chat.once('reply', r));

test('a crew member keeps their own session and replies in their own words', async () => {
  const { fake, runs } = fakeClaude();
  const chat = new CrewChat({ ...C.DEFAULTS }, fake);
  const progress = [];
  chat.on('progress', (p) => progress.push(p));
  let got = reply(chat);
  assert.equal(chat.say('karen', "what's new on LinkedIn?"), true);
  assert.equal(chat.say('karen', 'and X?'), false, 'one message at a time');
  assert.deepEqual(await got, { agent: 'karen', text: 'Two new messages, sir. Shall I draft replies?', ok: true });
  assert.deepEqual(progress, [{ agent: 'karen', status: 'checking LinkedIn' }]);
  const first = runs()[0];
  assert.match(first, /^You are KAREN/m);
  assert.match(first, /TALKING WITH THE USER DIRECTLY/);
  assert.ok(!first.includes('--resume'));

  got = reply(chat);
  chat.say('karen', 'yes, draft them');
  await got;
  assert.ok(runs()[1].includes('\n--resume\nsess-karen-1\n'), 'the second message resumes her session');
  assert.deepEqual(chat.contexts.karen.lines.map((l) => [l.who, l.text]), [
    ['user', "what's new on LinkedIn?"], ['karen', 'Two new messages, sir. Shall I draft replies?'],
    ['user', 'yes, draft them'], ['karen', 'Two new messages, sir. Shall I draft replies?'],
  ]);
  assert.ok(fs.readFileSync(C.BRAIN_SESSIONS_FILE, 'utf8').includes('sess-karen-1'), 'the radar hides her session');

  chat.reset('karen');
  got = reply(chat);
  chat.say('karen', 'hello');
  await got;
  assert.ok(!runs()[2].includes('--resume'), 'a reset starts her fresh');
});

test('a long chat is summarised and the next message starts fresh, carrying the summary', async () => {
  const { fake, runs } = fakeClaude();
  const chat = new CrewChat({ ...C.DEFAULTS }, fake);
  chat.reset();
  for (let i = 0; i < 20; i++) chat.contexts.edith.add(i % 2 ? 'edith' : 'user', `turn ${i}`);
  chat.sessions.edith = { session: 'sess-edith-old', tokens: 90000 };
  // The stand-in answers the summary call too: its result line is what comes back.
  await chat.maybeRoll('edith');
  assert.equal(chat.sessions.edith.session, '');
  assert.match(chat.contexts.edith.carried, /EDITH: turn 19/);
  const got = reply(chat);
  chat.say('edith', 'is this link safe?');
  await got;
  const last = runs()[runs().length - 1];
  assert.ok(!last.includes('--resume'));
  assert.match(last, /EARLIER CONVERSATION/);
});

test('direct messages show in the crew member\'s chat as the user\'s own', () => {
  const conv = new Conversations();
  const id = conv.directAsk('karen', 'draft my LinkedIn headline');
  assert.equal(conv.running('karen'), 1);
  conv.directResult(id, 'Here are two options, sir.', true);
  assert.deepEqual(conv.entries('karen').slice(-2).map((e) => [e.who, e.name, e.text]), [['you', 'YOU', 'draft my LinkedIn headline'], ['crew', 'KAREN', 'Here are two options, sir.']]);
  assert.equal(conv.running('karen'), 0);
});
