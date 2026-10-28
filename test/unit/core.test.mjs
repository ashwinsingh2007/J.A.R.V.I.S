// Unit tests for the pure parts of JARVIS. They run in plain Node (no Electron,
// no microphone), so CI can run them on any OS: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PYTHON } from '../python.mjs';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
process.env.JARVIS_STATE_DIR = STATE;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
const util = require('../../src/main/util');
util.initPaths(ROOT);
const { SentenceSplitter, systemPrompt, workerPrompt } = require('../../src/main/brain/common');
const { matches, isCommand, WAKE_PHRASES, SLEEP_PHRASES, STANDBY_PHRASES } = require('../../src/main/wake');
const { Memory } = require('../../src/main/memory');
const { Scheduler, nextDue } = require('../../src/main/scheduler');

const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

test('clean() makes text fit to be spoken', () => {
  assert.equal(util.clean('**Bold** and `code` with [a link](https://x.com).'), 'Bold and code with a link.');
  assert.equal(util.clean('Rated 7.2 (source: https://imdb.com/t) by critics [1][2].'), 'Rated 7.2 by critics.');
  assert.equal(util.clean('See https://example.com/page now'), 'See now');
});

test('a trailing sources list is never read aloud', () => {
  assert.equal(util.cutSources('It launched today.\n\nSources:\n- [Verge](https://x)'), 'It launched today.');
  assert.equal(util.cutSources('No list here.'), 'No list here.');
  assert.ok(util.SOURCES_START.test('Sources: - [Verge](https://x)'));
  assert.ok(!util.SOURCES_START.test('Sources say it is good.'));
});

test('which() finds an executable on PATH and gives up on one that is not there', () => {
  const known = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const found = util.which(known);
  assert.ok(found, `expected to find ${known}`);
  assert.ok(path.isAbsolute(found));
  assert.ok(fs.existsSync(found));
  assert.equal(util.which('jarvis-no-such-binary-zzz'), null);
  assert.equal(util.which(''), null);
});

test('env() keeps the inherited environment and a usable PATH', () => {
  const key = process.platform === 'win32' ? 'SystemRoot' : 'HOME';
  const e = util.env({ JARVIS_TEST_SENTINEL: 'yes' });
  assert.equal(e.JARVIS_TEST_SENTINEL, 'yes');
  assert.equal(e[key], process.env[key]);
  assert.ok(e.PATH, 'PATH must never be empty');
  assert.ok(e.PATH.split(path.delimiter).filter(Boolean).length >= 1);
});

test('initPaths points at the venv layout of this platform', () => {
  const win = process.platform === 'win32';
  const p = util.initPaths(ROOT);
  assert.equal(p.python, path.join(ROOT, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python3'));
  assert.equal(p.edgeTTS, path.join(ROOT, '.venv', win ? 'Scripts' : 'bin', win ? 'edge-tts.exe' : 'edge-tts'));
});

test('sentence splitter emits whole sentences as text streams in', () => {
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x));
  s.push('Good morning, sir. It is ');
  s.push('half past eight. Version 2.1 is out');
  s.flush(true);
  assert.deepEqual(out, ['Good morning, sir.', 'It is half past eight.', 'Version 2.1 is out']);
});

test('wake phrases are recognised', () => {
  assert.ok(matches('jarvis wake up', WAKE_PHRASES));
  assert.ok(!matches('what time is it', WAKE_PHRASES));
  assert.ok(isCommand('sleep', SLEEP_PHRASES));
  assert.ok(isCommand('Jarvis, go to sleep now.', SLEEP_PHRASES));
  assert.ok(isCommand('okay that will be all thank you', SLEEP_PHRASES));
  assert.ok(!isCommand('enjoy sleep', SLEEP_PHRASES));
  assert.ok(!isCommand("i couldn't sleep last night", SLEEP_PHRASES));
  assert.ok(!isCommand("i couldn't sleep", SLEEP_PHRASES));
  assert.ok(isCommand("wait don't do anything and also go to sleep", SLEEP_PHRASES));
  assert.ok(isCommand("why didn't you go to sleep", SLEEP_PHRASES));
  assert.ok(isCommand('jarvis go to sleep now please', SLEEP_PHRASES));
  assert.ok(isCommand('jarvis standby', STANDBY_PHRASES));
  assert.ok(!isCommand('can you mute the music', STANDBY_PHRASES));
});

test('config sanitising replaces junk with defaults', () => {
  const c = C.sanitize({ ...C.DEFAULTS, effort: 'turbo', commandSilenceSeconds: -7, checkIns: 'always', ollamaUrl: 'ftp://x' });
  assert.equal(c.effort, C.DEFAULTS.effort);
  assert.equal(c.commandSilenceSeconds, 0.5);
  assert.equal(c.checkIns, C.DEFAULTS.checkIns);
  assert.equal(c.ollamaUrl, C.DEFAULTS.ollamaUrl);
});

test('screen-control instructions follow the setting', () => {
  const on = { ...C.DEFAULTS, screenControl: true }, off = { ...C.DEFAULTS, screenControl: false };
  assert.match(systemPrompt(on), /hands\.sh/);
  assert.match(workerPrompt(on), /hands\.sh/);
  assert.doesNotMatch(systemPrompt(off), /hands\.sh/);
  assert.doesNotMatch(workerPrompt(off) + systemPrompt(on), /<!--\/?screen-->/);
});

test('repeating items move to their next time', () => {
  const at = (s) => new Date(s);
  assert.equal(local(nextDue('2026-10-23T08:00', 'daily', at('2026-10-25T09:00'))), '2026-10-26T08:00');
  assert.equal(local(nextDue('2026-10-23T08:00', 'weekdays', at('2026-10-24T09:00'))), '2026-10-26T08:00'); // Sat → Mon
  assert.equal(local(nextDue('2026-10-25T13:00', 'hourly', at('2026-10-25T13:20'))), '2026-10-25T14:00');
  assert.equal(local(nextDue('2026-10-20T10:00', 'weekly', at('2026-10-25T09:00'))), '2026-10-27T10:00');
});

test('scheduler fires due items once, drops one-offs and reschedules repeats', () => {
  const past = local(new Date(Date.now() - 5 * 60000)), later = local(new Date(Date.now() + 3600000));
  fs.writeFileSync(path.join(STATE, 'schedule.json'), JSON.stringify({ items: [
    { id: 'a', kind: 'reminder', text: 'one-off', due: past, repeat: null },
    { id: 'b', kind: 'task', text: 'daily job', due: past, repeat: 'daily' },
    { id: 'c', kind: 'reminder', text: 'not yet', due: later, repeat: null },
  ] }));
  const s = new Scheduler();
  const fired = [];
  s.on('due', (it, late) => fired.push([it.id, late]));
  s.tick();
  assert.deepEqual(fired.map((f) => f[0]), ['a', 'b']);
  assert.ok(fired[0][1] >= 4);
  const saved = JSON.parse(fs.readFileSync(path.join(STATE, 'schedule.json'), 'utf8')).items;
  assert.deepEqual(saved.map((i) => i.id).sort(), ['b', 'c']);
  assert.ok(new Date(saved.find((i) => i.id === 'b').due) > new Date());
  s.tick();
  assert.equal(fired.length, 2);
});

test('memory moves old memory.md facts, adds, forgets and keeps a journal', () => {
  fs.writeFileSync(C.MEMORY_FILE, '- Likes lo-fi.\n- Lives in Pune.\n');
  const m = new Memory();
  assert.equal(m.facts.length, 2);
  m.add('Has a cat called Momo.');
  m.add('has a cat called momo.');                 // duplicate, ignored
  assert.equal(m.facts.length, 3);
  assert.ok(m.forget(m.facts[0].id));
  assert.equal(new Memory().facts.length, 2);
  assert.match(m.promptText(), /Momo/);
  m.journal('You', 'what is the time');
  assert.match(m.readJournal(0), /You: what is the time/);
});

const py = (script, ...args) => spawnSync(PYTHON, ['-I', path.join(ROOT, 'scripts', script), ...args], { env: { ...process.env, JARVIS_STATE_DIR: STATE }, encoding: 'utf8' });

test('memory.py, the brain\'s memory tool', () => {
  assert.match(py('memory.py', 'add', '--topic', 'person', "Ravi is the user's brother.").stdout, /remembered/);
  assert.match(py('memory.py', 'search', 'ravi').stdout, /brother/);
  assert.match(py('memory.py', 'forget', 'ravi', 'brother').stdout, /forgot/);
  assert.equal(py('memory.py', 'forget', 'nobody').status, 1);
});

test('remind.py, the brain\'s reminder tool', () => {
  assert.match(py('remind.py', 'add', '--at', '+20m', 'call the bank').stdout, /scheduled: .* reminder/);
  assert.match(py('remind.py', 'task', '--at', '08:00', '--repeat', 'weekdays', 'summarise my inbox').stdout, /on weekdays/);
  assert.equal(py('remind.py', 'add', '--at', 'tomorrow', 'x').status, 2);
  assert.equal(py('remind.py', 'add', '--at', '+1h', '--repeat', 'yearly', 'x').status, 2);
  assert.match(py('remind.py', 'cancel', 'bank').stdout, /cancelled/);
});

test('assistants: a preset under the user\'s own changes, and the old settings become JARVIS\'s', () => {
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify({ onboarded: true, model: 'haiku', kokoroVoice: 'am_michael', radioFavourites: [{ id: 'r1', name: 'Mirchi' }] }));
  let c = C.load();
  assert.deepEqual([c.assistant, c.model, c.effort, c.kokoroVoice, c.wakeWords[0]], ['jarvis', 'haiku', 'medium', 'am_michael', 'jarvis']);
  assert.deepEqual(JSON.parse(fs.readFileSync(C.CONFIG_FILE, 'utf8')).radioFavourites, [{ id: 'r1', name: 'Mirchi' }]);
  C.save({ assistant: 'friday' });
  c = C.load();
  assert.deepEqual([c.model, c.effort, c.kokoroVoice, c.wakeWords[0]], ['opus', 'high', 'bf_emma', 'friday']);
  C.save({ effort: 'medium' });
  assert.equal(C.load().effort, 'medium');
  C.save({ assistant: 'jarvis' });
  assert.equal(C.load().model, 'haiku');
  C.resetAssistant('jarvis');
  assert.equal(C.load().model, 'sonnet');
  C.save({ assistant: 'nobody' });
  assert.equal(C.load().assistant, 'jarvis');
  assert.match(systemPrompt({ ...C.DEFAULTS, assistant: 'friday' }), /You are FRIDAY, the personal AI[\s\S]*Never say the word "FRIDAY"/);
  assert.doesNotMatch(systemPrompt({ ...C.DEFAULTS, assistant: 'friday' }), /\{\{/);
  fs.rmSync(C.CONFIG_FILE);
});

test('while awake, the name only counts when the user addresses the assistant with it', () => {
  const EventEmitter = require('events');
  const { Wake } = require('../../src/main/wake');
  const ears = Object.assign(new EventEmitter(), { setAwake() {}, armed() {}, reset() {}, mute() {} });
  const w = new Wake({ ...C.DEFAULTS, wakeWords: ['friday'] }, ears);
  assert.ok(w.addressed('friday what is next'));
  assert.ok(w.addressed('hey friday, what is next'));
  assert.equal(w.addressed('the meeting on friday at nine'), null);
  assert.equal(w.addressed('book it for friday'), null);
  assert.ok(w.lastWake('blah blah friday stop'));
});

test('the user can make their own assistant and rewrite any persona', () => {
  const { allAssistants, findByName, newId, assistantOf } = require('../../src/main/assistants');
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify({ onboarded: true }));
  C.saveCustom('coach', { name: 'COACH', tier: 'YOUR OWN', about: 'Started from FRIDAY.', needs: 'Claude Code', hello: '', persona: 'A patient running coach.', settings: { ...assistantOf('friday').settings, wakeWords: ['coach'] } });
  C.saveProfile('jarvis', { persona: 'A cheerful pirate.' });
  let c = C.load();
  assert.deepEqual(allAssistants(c).map((a) => a.id), ['jarvis', 'friday', 'karen', 'edith', 'vision', 'coach']);
  assert.equal(findByName('Coach', c), 'coach');
  assert.equal(newId('Coach', c), 'coach-2');
  assert.match(systemPrompt(c), /You are JARVIS[^\n]*A cheerful pirate\./);
  C.save({ assistant: 'coach' });
  c = C.load();
  assert.deepEqual([c.assistant, c.model, c.wakeWords[0]], ['coach', 'opus', 'coach']);
  assert.match(systemPrompt(c), /You are COACH[^\n]*A patient running coach\./);
  C.saveProfile('jarvis', { persona: null });
  C.saveCustom('coach', null);
  c = C.load();
  assert.equal(c.assistant, 'jarvis');
  assert.match(systemPrompt(c), /Think of the JARVIS who served Tony Stark/);
  fs.rmSync(C.CONFIG_FILE);
});

test('the Agents tab can set any assistant\'s brain and voice, not only the one in use', () => {
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify({ onboarded: true, assistant: 'jarvis' }));
  C.saveSettings('karen', { brainProvider: 'gemini', geminiModel: ' gemini-pro-latest ', kokoroSpeed: 9, effort: 'extreme', model: 'haiku', wakeWords: ['x'], ttsEngine: 'edge' });
  const raw = JSON.parse(fs.readFileSync(C.CONFIG_FILE, 'utf8'));
  // haiku is KAREN's preset, so it isn't stored; junk and non-assistant keys are dropped.
  assert.deepEqual(raw.assistantSettings.karen, { brainProvider: 'gemini', geminiModel: 'gemini-pro-latest', kokoroSpeed: 2 });
  assert.equal(C.load().brainProvider, 'auto');
  C.save({ assistant: 'karen' });
  assert.deepEqual([C.load().brainProvider, C.load().geminiModel], ['gemini', 'gemini-pro-latest']);
  C.saveSettings('nobody', { model: 'opus' });
  assert.ok(!JSON.parse(fs.readFileSync(C.CONFIG_FILE, 'utf8')).assistantSettings.nobody);
  fs.rmSync(C.CONFIG_FILE);
});

test('an assistant whose brain is not set up says what it needs, and falls back to one that is', () => {
  const { choose, unavailable } = require('../../src/main/brain');
  const found = { claude: { path: '/bin/claude', loggedIn: true }, ollama: { running: false, models: [] } };
  const edith = { ...C.DEFAULTS, brainProvider: 'ollama' };
  assert.match(unavailable(edith, found), /Ollama/);
  assert.equal(choose(edith, found), 'claude-code');
  assert.equal(choose(edith, { ...found, ollama: { running: true, models: ['llama3.2'] } }), 'ollama');
  assert.equal(unavailable({ ...C.DEFAULTS, brainProvider: 'gemini' }, found), 'a Gemini API key');
  assert.equal(unavailable({ ...C.DEFAULTS, brainProvider: 'auto' }, found), '');
});

test('a running job shows its progress on the HUD but is never announced until it ends', (t) => {
  const { Orchestrator } = require('../../src/main/orchestrator');
  const EventEmitter = require('node:events');
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'setImmediate', 'Date'] });
  const said = [], notices = [];
  const stub = { start() {}, watch() {}, warmUp() {}, scan() {}, loadDirectory() {} };
  const brain = Object.assign(new EventEmitter(), { warmUp() {}, isBusy: false });
  const o = Object.assign(Object.create(Orchestrator.prototype), {
    // Awake, idle and quiet: everything a spoken update would have waited for.
    cfg: { ...C.DEFAULTS, checkIns: 'off' }, brain, progress: new Map(), wake: { conversationMode: true }, _state: 'idle', lastHeard: 0, lastSpokeAt: 0,
    source: { kind: 'voice' }, conv: { job() {}, progress() {} },
    speaker: { speak: (s) => said.push(s), isSpeaking: false }, radar: stub, monitor: stub, inbox: stub, memory: stub, scheduler: stub, music: stub, ears: stub,
    hud: { send: (k, v) => { if (k === 'notice') notices.push(v.text); }, sendRaw() {} },
    sendStats() {}, sendConversation() {}, sendMusicStations() {},
  });
  o.wireBrain(brain);
  o.start();
  brain.emit('task', { id: 'j1', description: 'checking your Gmail', status: 'running' });
  for (const [i, line] of ['Your inbox is open.', 'Reading today\'s emails now.', 'Found three that need a reply.'].entries()) {
    t.mock.timers.tick(20000 * (i + 1));
    brain.emit('progress', { id: 'j1', status: line });
  }
  t.mock.timers.tick(10 * 60000);
  assert.deepEqual(said, []);
  assert.ok(notices.includes('Found three that need a reply.'));
  assert.match(o.statusLine(), /^Checking your Gmail, for \d+ minutes now\. Found three that need a reply\.$/);
  brain.emit('task', { id: 'j1', description: 'checking your Gmail', status: 'completed' });
  assert.equal(o.progress.size, 0);
  assert.equal(notices.at(-1), 'Finished: checking your Gmail');
});

test('findClaude() finds claude in its install locations when PATH lacks it', (t) => {
  if (['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some((p) => fs.existsSync(p))) return t.skip('claude is installed system-wide here');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
  assert.equal(util.findClaude({ home, usePath: false, shell: null }), null);
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  for (const v of ['v9.0.0', 'v20.11.0']) {
    fs.mkdirSync(path.join(nvm, v, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(nvm, v, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  }
  assert.equal(util.findClaude({ home, usePath: false, shell: null }), path.join(nvm, 'v20.11.0', 'bin', 'claude'));
  const native = path.join(home, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(util.findClaude({ home, usePath: false, shell: null }), path.join(nvm, 'v20.11.0', 'bin', 'claude'), 'not executable: skipped');
  fs.chmodSync(native, 0o755);
  assert.equal(util.findClaude({ home, usePath: false, shell: null }), native, 'native installer wins');
});

test('echo cancellation runs only while JARVIS talks or music plays, and switches off once nobody speaks', (t) => {
  const { Orchestrator } = require('../../src/main/orchestrator');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const o = Object.assign(Object.create(Orchestrator.prototype), {
    cfg: { ...C.DEFAULTS }, _state: 'idle', lastHeard: 0,
    ears: { echo: (on) => sent.push(on) }, speaker: { isSpeaking: false }, music: { playing: false }, youtube: { playing: false },
  });
  o._state = 'speaking'; o.updateEcho();
  assert.deepEqual(sent, [true]);
  o._state = 'idle'; o.updateEcho();
  t.mock.timers.tick(4000);
  assert.deepEqual(sent, [true], 'still on during the grace period');
  o._state = 'listening'; o.lastHeard = Date.now();
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, [true], 'not switched while the user is talking');
  o._state = 'idle';
  t.mock.timers.tick(4000);
  assert.deepEqual(sent, [true, false]);
  o.music.playing = true; o.updateEcho();
  assert.deepEqual(sent, [true, false, true], 'music needs it');
  o.music.playing = false; o.cfg.echoCancel = 'always'; o.updateEcho();
  t.mock.timers.tick(60000);
  assert.deepEqual(sent, [true, false, true, true], '"always" never switches it off');
});
