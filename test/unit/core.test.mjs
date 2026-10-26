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
const { SentenceSplitter, systemPrompt, agentPrompt } = require('../../src/main/brain/common');
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
  assert.match(agentPrompt(on), /hands\.sh/);
  assert.doesNotMatch(systemPrompt(off), /hands\.sh/);
  assert.doesNotMatch(agentPrompt(off) + systemPrompt(on), /<!--\/?screen-->/);
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

test('each crew member speaks in their own voice, and a broken one falls back to JARVIS\'s', async () => {
  const EventEmitter = require('events');
  const Speaker = require('../../src/main/speaker');
  const audio = new EventEmitter();
  const played = [];
  audio.playTTS = (f) => { played.push(f); setImmediate(() => audio.emit('tts-ended')); };
  audio.stopTTS = () => {};
  const cfg = C.sanitize({ ...C.DEFAULTS, ttsEngine: 'native', crewVoices: { karen: { native: 'Broken' }, edith: { native: '$(rm -rf /)' } } });
  assert.equal(cfg.crewVoices.edith.native, 'Tessa');
  assert.equal(cfg.crewVoices.friday.kokoro, 'bf_emma');
  const sp = new Speaker(cfg, audio);
  const voices = [];
  sp.synth_native = async (s, voice) => { voices.push([s, voice]); if (voice === 'Broken') throw new Error('no such voice'); return `/tmp/${voices.length}.wav`; };
  const done = new Promise((r) => sp.once('finish', r));
  sp.speak('Good evening.');
  sp.speak('Three new emails.', 'karen');
  sp.speak('All clear.', 'edith');
  await done;
  assert.deepEqual(voices, [['Good evening.', 'Daniel'], ['Three new emails.', 'Broken'], ['All clear.', 'Tessa'], ['Three new emails.', 'Daniel']]);
  assert.equal(played.length, 3);
  assert.equal(sp.engine, 'native');
});
