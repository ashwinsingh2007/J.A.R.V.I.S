// The voices and listening languages the HUD offers: French voices for the Edge and macOS engines,
// Quebec French for the ears, and a saved voice that is not in a list is kept, never reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
process.env.JARVIS_STATE_DIR = STATE;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const C = require('../../src/main/config');
const { sayVoiceNames } = require('../../src/main/util');
const HUD = fs.readFileSync(path.join(ROOT, 'src/renderer/hud/index.html'), 'utf8');

// The <option>s of the HUD <select> with this attribute, as [value, label].
function options(attr) {
  const m = new RegExp(`<select ${attr}[^>]*>([\\s\\S]*?)</select>`).exec(HUD);
  assert.ok(m, `no <select ${attr}> in the HUD`);
  return [...m[1].matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map((o) => [o[1] ?? o[2], o[2]]);
}

test('the Agents tab offers French Edge voices, with clear labels', () => {
  const edge = new Map(options('data-s="edgeVoice"'));
  const french = {
    'fr-CA-AntoineNeural': 'Antoine (Quebec French, male)', 'fr-CA-JeanNeural': 'Jean (Quebec French, male)',
    'fr-CA-ThierryNeural': 'Thierry (Quebec French, male)', 'fr-CA-SylvieNeural': 'Sylvie (Quebec French, female)',
    'fr-FR-HenriNeural': 'Henri (French, male)', 'fr-FR-DeniseNeural': 'Denise (French, female)', 'fr-FR-EloiseNeural': 'Eloise (French, female)',
    'fr-FR-RemyMultilingualNeural': 'Remy (French, male, multilingual)', 'fr-FR-VivienneMultilingualNeural': 'Vivienne (French, female, multilingual)',
  };
  for (const [v, label] of Object.entries(french)) assert.equal(edge.get(v), label, v);
  // The English ones are still there.
  for (const v of ['en-GB-RyanNeural', 'en-IE-EmilyNeural', 'en-US-JennyNeural']) assert.ok(edge.has(v), v);
});

test('the macOS voice list keeps the French voices, Quebec and France, and still leaves out the rest', () => {
  const out = [
    'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
    'Eddy (French (Canada)) fr_CA    # Bonjour! Je m’appelle Eddy.',
    'Eddy (French (France)) fr_FR    # Bonjour, je m’appelle Eddy.',
    'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
    'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Zarvox              en_US    # Hello! My name is Zarvox.',
    'Anna                de_DE    # Hallo! Ich heiße Anna.',
    'Paulina             es_MX    # Hola, me llamo Paulina.',
  ].join('\n');
  assert.deepEqual(sayVoiceNames(out), ['Amélie', 'Eddy (French (Canada))', 'Eddy (French (France))', 'Thomas', 'Daniel (English (UK))', 'Samantha']);
  assert.deepEqual(sayVoiceNames(''), []);
});

test('Settings › Language offers Quebec French next to French', () => {
  const langs = options('data-key="speechLocale"').map(([v]) => v);
  assert.ok(langs.includes('fr-FR') && langs.includes('fr-CA'));
  assert.equal(langs.indexOf('fr-CA'), langs.indexOf('fr-FR') + 1);
  // The code goes to the recogniser as is, and survives a reload.
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify({ onboarded: true, speechLocale: 'fr-CA' }));
  assert.equal(C.load().speechLocale, 'fr-CA');
  fs.rmSync(C.CONFIG_FILE);
});

test('an agent\'s saved voice that is not in any list is kept as it is', () => {
  fs.writeFileSync(C.CONFIG_FILE, JSON.stringify({ onboarded: true, assistant: 'jarvis' }));
  C.saveSettings('jarvis', { edgeVoice: 'es-ES-AlvaroNeural', nativeVoice: 'Amélie' });
  C.saveSettings('friday', { edgeVoice: 'fr-CA-SylvieNeural', nativeVoice: 'Eddy (French (Canada))' });
  const c = C.load();
  assert.deepEqual([c.edgeVoice, c.nativeVoice], ['es-ES-AlvaroNeural', 'Amélie']);
  // Another agent's, as the Agents tab reads it without switching to it.
  const f = C.load('friday');
  assert.deepEqual([f.edgeVoice, f.nativeVoice], ['fr-CA-SylvieNeural', 'Eddy (French (Canada))']);
  fs.rmSync(C.CONFIG_FILE);
});
