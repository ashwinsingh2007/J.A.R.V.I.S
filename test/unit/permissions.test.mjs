// Unit tests for the permission list when the speech helper is missing (it needs macOS 14 to build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JARVIS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'src/main/util.js')).initPaths(ROOT);
const perms = require(path.join(ROOT, 'src/main/permissions.js'));

test('microphone and speech report no-helper when the speech helper is not built', async () => {
  const s = await perms.state(path.join(os.tmpdir(), 'no-such-jarvis-ears'));
  assert.equal(s.mic, 'no-helper');
  assert.equal(s.speech, 'no-helper');
});

test('asking for the microphone without the helper returns the state instead of failing silently', async () => {
  const opened = [];
  const s = await perms.ask('mic', { earsBin: path.join(os.tmpdir(), 'no-such-jarvis-ears'), openPane: (p) => opened.push(p), notify: () => {} });
  assert.equal(s.mic, 'no-helper');
  assert.deepEqual(opened, []);
});
