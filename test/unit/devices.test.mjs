// JARVIS on the user's other devices: pairing codes and proofs, the relay's encryption, and the checks
// on what comes in through it. No network: the relay is a fake, the swarm a stand-in for its keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
process.env.HOME = HOME;
process.env.JARVIS_STATE_DIR = path.join(HOME, '.jarvis');
const require = createRequire(import.meta.url);
const D = require('../../src/main/devices');

test('pairing codes: 8 characters, typed any way, unambiguous letters only', () => {
  const c = D.newCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(D.normCode('k7m2 9qxa'), 'K7M29QXA');
  assert.equal(D.normCode('K7M2-9QXA'), 'K7M29QXA');
  assert.equal(D.normCode('K7M2-9QX0'), '', 'no zero');
  assert.equal(D.normCode('short'), '');
});

test('both sides prove the code without sending it, and a wrong code fails', () => {
  const a = crypto.randomBytes(32), b = crypto.randomBytes(32);
  const k = D.pairKeys('K7M2-9QXA');
  assert.equal(k.topic.length, 32);
  assert.deepEqual(D.pairKeys('k7m2 9qxa').topic, k.topic);
  const fromA = D.pairProof(k.auth, a, b);
  assert.equal(D.pairProof(k.auth, a, b), fromA, 'B checks A\'s proof the same way');
  assert.notEqual(D.pairProof(k.auth, b, a), fromA, 'a proof can\'t be bounced back');
  assert.notEqual(D.pairProof(D.pairKeys('K7M2-9QXB').auth, a, b), fromA);
});

test('relay messages are sealed: tampering or the wrong key gives nothing', () => {
  const key = crypto.randomBytes(32);
  const box = D.seal(key, { hi: 'there' });
  assert.deepEqual(D.open(key, box), { hi: 'there' });
  const bad = Buffer.from(box, 'base64'); bad[bad.length - 1] ^= 1;
  assert.equal(D.open(key, bad.toString('base64')), null);
  assert.equal(D.open(crypto.randomBytes(32), box), null);
});

/** A device with keys but no network, and a relay that just records what is posted. */
function device(name, posted) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-'));
  const d = new D.Devices({ dir, relayFetch: async (url, opt) => { posted.push({ url, body: opt.body }); return { ok: true, status: 200 }; } });
  d.data.name = name;
  d.swarm = { keyPair: { publicKey: crypto.randomBytes(32) } };
  return d;
}

test('a frame goes through the relay in parts and arrives once, from the right device', async () => {
  const posted = [];
  const a = device('A', posted), b = device('B', posted);
  const secret = crypto.randomBytes(32).toString('hex');
  a.data.peers.push({ id: b.id, name: 'B', os: 'macOS', secret });
  b.data.peers.push({ id: a.id, name: 'A', os: 'Windows', secret });
  const got = [];
  b.on('task', (p, f) => got.push([p.name, f.task.length]));
  assert.equal(await a.relaySend(a.data.peers[0], { t: 'task', id: 'r1', description: 'big', task: 'x'.repeat(9000) }), '');
  assert.ok(posted.length > 1, 'split into parts under the relay\'s size limit');
  assert.ok(posted.every((p) => p.body.length < 4096));
  const topic = posted[0].url.split('/').pop();
  assert.equal(topic, D.relayTopic(Buffer.from(secret, 'hex'), b.id));
  for (const p of posted) b.onRelay(topic, p.body);
  assert.deepEqual(got, [['A', 9000]]);
  for (const p of posted) b.onRelay(topic, p.body);
  assert.equal(got.length, 1, 'a replay is ignored');
  // Another device that knows the topic but not the pair's key gets nowhere.
  const c = device('C', []);
  posted.length = 0;
  await c.relaySend({ id: b.id, name: 'B', secret: crypto.randomBytes(32).toString('hex') }, { t: 'task', id: 'r2', task: 'evil' });
  for (const p of posted) b.onRelay(topic, p.body);
  assert.equal(got.length, 1);
});

test('the relay\'s daily limit is reported plainly', async () => {
  const d = device('A', []);
  d.fetch = async () => ({ ok: false, status: 429 });
  const msg = await d.relaySend({ id: 'b'.repeat(64), name: 'B', secret: 'c'.repeat(64) }, { t: 'status?' });
  assert.match(msg, /daily limit/);
});

test('paired devices are kept with their secrets, and a name is unique', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-'));
  const d = new D.Devices({ dir });
  d.data.peers.push({ id: 'a'.repeat(64), name: 'Home Mac', os: 'macOS', secret: 'b'.repeat(64) });
  d.save();
  assert.equal(fs.statSync(path.join(dir, 'devices.json')).mode & 0o777, 0o600);
  const again = new D.Devices({ dir });
  assert.equal(again.peer('home mac').secret, 'b'.repeat(64));
  assert.equal(again.data.seed, d.data.seed, 'the same identity after a restart');
  assert.equal(again.uniqueName('Home Mac'), 'Home Mac 2');
});
