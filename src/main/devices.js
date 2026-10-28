// JARVIS on the user's other computers: pair them once with a code, then hand tasks to each other.
//
// Paired devices find each other through Hyperswarm (a peer-to-peer network: a public directory of
// peers, then a direct, Noise-encrypted connection through both routers, or over the local network
// when they share one). Nothing listens on a fixed port. When a direct connection isn't possible, the
// messages go through an ntfy relay (ntfy.sh by default), encrypted with the pair's own key first, so
// the relay only ever carries unreadable data.
//
// Pairing: one device shows a code, the other types it. The code (stretched with scrypt) gives a
// rendezvous topic and a key both sides prove they hold; the device that showed the code then sends
// a fresh 32-byte secret over that connection. The secret names the pair's topic and keys the relay.
// Only paired devices' public keys get through the firewall.
//
// Messages are JSON frames: hello, status?, status, task, progress, result. A task from another device
// runs here as a background job (main.js), and its result goes back the way it came.
//
// Another device's HUD can show this one's: over a direct connection it 'watch'es and gets a snapshot
// ('snap') of the HUD events listed in MIRROR, then each new one ('ev'). Over the relay, which has a
// daily limit, it asks for a snapshot ('get') instead. It can also type to this JARVIS ('say') and
// change its agents ('act'); main.js decides what it may do.
//
// events: 'change' (the list or a connection changed), 'task' (peer, frame), 'pair' ({ state, ... }),
//         'remote' (peer, { snap } | { e }), 'say' (peer, text, voice), 'said' (peer, text), 'act' (peer, action)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const C = require('./config');
const { log } = require('./util');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_MINUTES = 3;
const MAX_FRAME = 4 * 1024 * 1024;  // a whole HUD snapshot (conversation included) fits
const RELAY_PART = 3000;            // characters of ciphertext per relay message (ntfy's limit is 4 KB)
const RELAY_MAX_AGE = 15 * 60000;   // older relay messages are replays or stale
// Node tries each address for only 250 ms before the next; a relay half the world away takes longer
// to answer than that, and every attempt then fails.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2000);
const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform;

const sha = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest();
const hex = (b) => Buffer.from(b).toString('hex');

/** "k7m2 9qxa" → "K7M29QXA"; '' when it can't be a code. */
function normCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 && [...c].every((x) => CODE_CHARS.includes(x)) ? c : '';
}

function newCode() {
  let c = '';
  for (const b of crypto.randomBytes(8)) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

/** The rendezvous topic and proof key for a pairing code. scrypt makes guessing codes slow. */
function pairKeys(code) {
  const k = crypto.scryptSync(normCode(code), 'jarvis-pair-v1', 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { topic: k.subarray(0, 32), auth: k.subarray(32) };
}

/** Proof that this side knows the code, bound to both public keys and to who sends it. */
function pairProof(auth, myKey, theirKey) {
  const both = [hex(myKey), hex(theirKey)].sort().join('');
  return crypto.createHmac('sha256', auth).update(`jarvis-pair|${both}|${hex(myKey)}`).digest('hex');
}

const peerTopic = (secret) => sha('jarvis-peer-v1', hex(secret));
// Pairing through the relay, for networks that block the peer-to-peer one: a topic and a key from the
// code (scrypt-stretched, so the relay can't guess them back), and nothing readable without the code.
const pairRelayTopic = (keys) => 'jp' + hex(sha('jarvis-pair-relay', hex(keys.topic))).slice(0, 40);
const pairRelayKey = (keys) => Buffer.from(crypto.hkdfSync('sha256', keys.auth, Buffer.alloc(0), 'jarvis-pair-relay-key', 32));
const relayKey = (secret) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'jarvis-relay-key', 32));
/** The relay topic for messages going to device `to`. */
const relayTopic = (secret, to) => 'jv' + hex(sha('jarvis-relay-topic', hex(secret), to)).slice(0, 40);

/** AES-256-GCM: iv | tag | ciphertext, base64. */
function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function open(key, text) {
  try {
    const b = Buffer.from(String(text), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  } catch { return null; }
}

/** Newline-delimited JSON over a stream, with a size limit. */
function frames(stream, onFrame) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    if (buf.length > MAX_FRAME) { stream.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let f = null;
      try { f = JSON.parse(line); } catch {}
      if (f && typeof f === 'object' && typeof f.t === 'string') onFrame(f);
    }
  });
}
const send = (stream, f) => { try { stream.write(JSON.stringify(f) + '\n'); return true; } catch { return false; } };

class Devices extends EventEmitter {
  /** dir: where devices.json and the device key live (~/.jarvis, or a test folder). */
  constructor({ dir = C.STATE_DIR, relayFetch = fetch } = {}) {
    super();
    this.file = path.join(dir, 'devices.json');
    this.fetch = relayFetch;
    this.data = this.load();
    this.swarm = null;
    this.conns = new Map();      // peer id -> live connection
    this.pending = new Map();    // request id -> { resolve, timer, peer }
    this.seen = new Set();       // relay message ids already handled
    this.parts = new Map();      // relay message id -> parts
    this.pairing = null;         // { role, code, keys, discovery, timer }
    this.relayAbort = null;
    this.topics = new Map();     // peer id -> its swarm discovery
    this.refresher = null;
    this.mirrorCache = {};       // HUD event type -> its latest payload, for another device's view
    this.watchers = new Set();   // peer ids watching this device's HUD
    this.mirrorTimers = new Map();
  }

  // ---------- state ----------

  load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    const seed = C.decrypt(d.seed || '');
    return {
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 40) : os.hostname().replace(/\.local$/, ''),
      seed: /^[0-9a-f]{64}$/.test(seed) ? seed : hex(crypto.randomBytes(32)),
      relay: { on: !(d.relay && d.relay.on === false), url: d.relay && /^https:\/\/[^\s/]+/.test(d.relay.url) ? d.relay.url.replace(/\/$/, '') : 'https://ntfy.sh' },
      peers: (Array.isArray(d.peers) ? d.peers : []).map((p) => ({ ...p, secret: C.decrypt(p.secret || '') })).filter((p) => /^[0-9a-f]{64}$/.test(p.id) && /^[0-9a-f]{64}$/.test(p.secret)),
    };
  }

  save() {
    const d = this.data;
    const out = { name: d.name, seed: C.encrypt(d.seed), relay: d.relay, peers: d.peers.map((p) => ({ ...p, secret: C.encrypt(p.secret) })) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(out, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  get id() { return this.swarm ? hex(this.swarm.keyPair.publicKey) : ''; }
  peer(idOrName) {
    const n = String(idOrName || '').toLowerCase();
    return this.data.peers.find((p) => p.id === idOrName || p.name.toLowerCase() === n) || null;
  }

  /** For the HUD and the brain: who is paired and how each is reached right now. */
  list() {
    return this.data.peers.map((p) => {
      const c = this.conns.get(p.id);
      return { id: p.id, name: p.name, os: p.os, pairedAt: p.pairedAt, lastSeen: p.lastSeen || '', via: c ? (c.rawStream && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(c.rawStream.remoteHost || '') ? 'local network' : 'direct') : this.data.relay.on ? 'relay' : 'offline' };
    });
  }

  setName(name) {
    name = String(name || '').replace(/[^\w .'-]/g, '').trim().slice(0, 40);
    if (!name) return 'Give this device a name.';
    this.data.name = name;
    this.save();
    for (const c of this.conns.values()) send(c, this.hello());
    this.emit('change');
    return '';
  }

  setRelay({ on, url }) {
    if (typeof on === 'boolean') this.data.relay.on = on;
    if (url !== undefined) {
      const u = String(url || '').trim().replace(/\/$/, '') || 'https://ntfy.sh';
      if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) return 'The relay must be an https address.';
      this.data.relay.url = u;
    }
    this.save();
    this.subscribeRelay();
    this.emit('change');
    return '';
  }

  // ---------- the swarm ----------

  /** Start when there is someone to talk to (or a pairing). Safe to call again. */
  async start() {
    // A stop still under way (the last pair was just removed) finishes first.
    if (this.stopping) await this.stopping;
    if (this.swarm) return;
    if (!this.data.peers.length && !this.pairing) return;
    const Hyperswarm = require('hyperswarm');
    // Only paired devices get through, plus anyone during a pairing (who must then prove the code).
    // Ephemeral: JARVIS only looks up its own pairs and never becomes a directory node serving others.
    const DHT = require('hyperdht');
    this.swarm = new Hyperswarm({ seed: Buffer.from(this.data.seed, 'hex'), dht: new DHT({ ephemeral: true }), firewall: (key) => !this.pairing && !this.peer(hex(key)) });
    this.save();
    this.startedAt = Date.now();
    this.swarm.on('connection', (conn) => this.onConnection(conn));
    for (const p of this.data.peers) this.joinPeer(p);
    // Two devices that joined at the same moment can miss each other's announcement, and a refresh
    // alone doesn't always find them again: leave and join afresh for any that aren't connected.
    this.refresher = setInterval(() => { for (const p of this.data.peers) if (!this.conns.get(p.id)) this.rejoin(p); }, 45000);
    this.subscribeRelay();
    log(`devices: started as ${this.data.name} with ${this.data.peers.length} paired`);
  }

  joinPeer(p) {
    this.topics.set(p.id, this.swarm.join(peerTopic(Buffer.from(p.secret, 'hex')), { server: true, client: true }));
  }

  async rejoin(p) {
    if (!this.swarm || this.conns.get(p.id)) return;
    const topic = peerTopic(Buffer.from(p.secret, 'hex'));
    await this.swarm.leave(topic).catch(() => {});
    if (this.swarm && this.peer(p.id) && !this.conns.get(p.id)) this.joinPeer(p);
  }

  async stop() {
    clearInterval(this.refresher);
    this.topics.clear();
    if (this.relayAbort) this.relayAbort.abort();
    this.relayAbort = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, text: 'JARVIS is shutting down.' }); }
    this.pending.clear();
    // The swarm goes at once, so nothing new joins it while it is being torn down.
    const swarm = this.swarm;
    this.swarm = null;
    this.conns.clear();
    if (swarm) { this.stopping = swarm.destroy().catch(() => {}); await this.stopping; this.stopping = null; }
  }

  hello() { return { t: 'hello', name: this.data.name, os: OS_NAME, v: 1 }; }

  onConnection(conn) {
    conn.on('error', () => {});
    const key = hex(conn.remotePublicKey);
    if (this.pairing && !this.peer(key)) return this.pairConnection(conn, key);
    const p = this.peer(key);
    if (!p) { conn.destroy(); return; }
    const old = this.conns.get(p.id);
    if (old && old !== conn) old.destroy();
    this.conns.set(p.id, conn);
    conn.on('close', () => { if (this.conns.get(p.id) === conn) { this.conns.delete(p.id); this.watchers.delete(p.id); this.emit('change'); } });
    frames(conn, (f) => this.onFrame(p, f));
    send(conn, this.hello());
    send(conn, { t: 'watch', on: true });
    p.lastSeen = new Date().toISOString().slice(0, 16);
    log(`devices: connected to ${p.name}`);
    this.emit('change');
  }

  // ---------- pairing ----------

  /** Show a code on this device ('host') or enter one from another device ('join'). */
  async pair(role, code = '') {
    this.cancelPair({ keep: true });
    code = role === 'host' ? newCode() : normCode(code);
    if (!code) return { error: 'That code should be 8 letters and numbers, like K7M2-9QXA.' };
    const keys = pairKeys(code);
    this.pairing = { role, code, keys, timer: setTimeout(() => { this.cancelPair(); this.emit('pair', { state: 'expired' }); }, PAIR_MINUTES * 60000) };
    if (!this.swarm) await this.start();
    const pg = this.pairing;
    pg.discovery = this.swarm.join(keys.topic, { server: true, client: true });
    // The relay too, at the same time: whichever finds the other device first wins.
    this.pairViaRelay(pg);
    // The code is shown once this device is findable, so the other one finds it straight away. A
    // network that blocks the peer-to-peer traffic never gets there: then the relay carries the pairing.
    const ready = role === 'host' ? pg.discovery.flushed() : this.swarm.flush();
    const ok = await Promise.race([ready.then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 15000))]);
    // Ended while getting ready: paired already (the other device was quick), or cancelled.
    if (this.pairing !== pg) return this.lastPairedAt && Date.now() - this.lastPairedAt < 120000 ? {} : { error: 'Cancelled.' };
    if (!ok) log('devices: the peer-to-peer network is not answering from here (UDP may be blocked); pairing through the relay');
    log(`devices: pairing (${role})`);
    // Still nothing after 45 seconds: say so, rather than wait in silence.
    pg.slow = setTimeout(() => { if (this.pairing === pg) { log('devices: pairing: no sign of the other device yet'); this.emit('pair', { state: 'slow', role }); } }, 45000);
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.emit('pair', { state: 'waiting', role, code: role === 'host' ? shown : '', minutes: PAIR_MINUTES });
    return { code: role === 'host' ? shown : '' };
  }

  /** keep: a new pairing follows straight away, so the swarm stays up. */
  cancelPair({ keep = false } = {}) {
    const pg = this.pairing;
    if (!pg) return;
    clearTimeout(pg.timer);
    clearTimeout(pg.slow);
    clearInterval(pg.resend);
    if (pg.relayAbort) pg.relayAbort.abort();
    if (this.swarm) this.swarm.leave(pg.keys.topic).catch(() => {});
    this.pairing = null;
    if (!keep && !this.data.peers.length) this.stop();
  }

  pairConnection(conn, key) {
    const pg = this.pairing;
    const mine = this.swarm.keyPair.publicKey;
    let theirs = null, done = false;
    const fail = (why) => { log(`devices: pairing failed: ${why}`); conn.destroy(); };
    frames(conn, (f) => {
      if (done) return;   // paired: the pair's own handler reads this connection now
      if (!this.pairing || this.pairing !== pg) return conn.destroy();
      if (f.t === 'pair') {
        if (f.proof !== pairProof(pg.keys.auth, conn.remotePublicKey, mine)) return fail('the other device has a different code');
        theirs = { name: String(f.name || 'Another device').slice(0, 40), os: String(f.os || '').slice(0, 20) };
        if (pg.role === 'host') {
          const secret = hex(crypto.randomBytes(32));
          send(conn, { t: 'pair-secret', secret });
          done = true;
          this.addPeer(key, theirs, secret, conn);
        }
      } else if (f.t === 'pair-secret' && pg.role === 'join' && theirs && /^[0-9a-f]{64}$/.test(f.secret)) {
        done = true;
        this.addPeer(key, theirs, f.secret, conn);
      }
    });
    send(conn, { t: 'pair', name: this.data.name, os: OS_NAME, proof: pairProof(pg.keys.auth, mine, conn.remotePublicKey) });
  }

  /**
   * Pairing over the relay. Both sides post who they are, sealed with the code's key; each answers the
   * other's with a proof bound to both public keys; the device that showed the code then sends the
   * pair's secret, again every few seconds, until the other confirms it ('got'). Only then does it
   * count as paired, so a lost message can't leave one side paired and the other not. Messages from
   * this device, or that don't open with the code's key, are ignored.
   */
  pairViaRelay(pg) {
    if (!this.data.relay.on) return;
    const key = pairRelayKey(pg.keys), url = `${this.data.relay.url}/${pairRelayTopic(pg.keys)}`;
    const me = this.id, mine = this.swarm.keyPair.publicKey;
    // A relay message can fail on a flaky network: try it three times.
    const post = async (f) => {
      for (let i = 0; i < 3; i++) {
        try { const r = await this.fetch(url, { method: 'POST', body: seal(key, { ...f, from: me, ts: Date.now() }), signal: AbortSignal.timeout(15000) }); if (r.ok) return; } catch (e) { if (i === 2) log(`devices: pairing relay: ${e.message}`); }
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    };
    let theirs = null, proved = false, secret = '';
    pg.relayAbort = new AbortController();
    this.relayStream(`${url}/json?since=${PAIR_MINUTES}m`, pg.relayAbort.signal, (_topic, text) => {
      if (this.pairing !== pg) return;
      const f = open(key, text);
      if (!f || f.from === me || !/^[0-9a-f]{64}$/.test(f.from) || Math.abs(Date.now() - f.ts) > RELAY_MAX_AGE) return;
      const them = Buffer.from(f.from, 'hex');
      if (f.t === 'hi') {
        theirs = { id: f.from, name: String(f.name || 'Another device').slice(0, 40), os: String(f.os || '').slice(0, 20) };
        post({ t: 'proof', to: f.from, name: this.data.name, os: OS_NAME, proof: pairProof(pg.keys.auth, mine, them) });
      } else if (f.t === 'proof' && f.to === me && f.proof === pairProof(pg.keys.auth, them, mine)) {
        if (!theirs || theirs.id !== f.from) theirs = { id: f.from, name: String(f.name || 'Another device').slice(0, 40), os: String(f.os || '').slice(0, 20) };
        if (proved) return;
        proved = true;
        log('devices: pairing through the relay');
        if (pg.role === 'host') {
          secret = hex(crypto.randomBytes(32));
          const to = f.from, send = () => post({ t: 'secret', to, secret });
          send();
          pg.resend = setInterval(() => { if (this.pairing === pg) send(); else clearInterval(pg.resend); }, 4000);
        } else post({ t: 'proof', to: f.from, name: this.data.name, os: OS_NAME, proof: pairProof(pg.keys.auth, mine, them) });
      } else if (f.t === 'secret' && f.to === me && pg.role === 'join' && proved && theirs && theirs.id === f.from && /^[0-9a-f]{64}$/.test(f.secret)) {
        // Confirm twice, a moment apart, in case one is lost; then the pair is ours.
        const to = f.from;
        post({ t: 'got', to });
        setTimeout(() => post({ t: 'got', to }), 2500);
        this.addPeer(f.from, theirs, f.secret, null);
      } else if (f.t === 'got' && f.to === me && pg.role === 'host' && secret && theirs && theirs.id === f.from) {
        clearInterval(pg.resend);
        this.addPeer(f.from, theirs, secret, null);
      }
    }).then(() => {});
    post({ t: 'hi', name: this.data.name, os: OS_NAME });
  }

  addPeer(id, who, secret, conn) {
    if (!this.pairing) return;   // the other path got there first
    clearTimeout(this.pairing.slow);
    clearInterval(this.pairing.resend);
    if (this.pairing.relayAbort) this.pairing.relayAbort.abort();
    this.data.peers = this.data.peers.filter((p) => p.id !== id);
    this.data.peers.push({ id, name: this.uniqueName(who.name), os: who.os, secret, pairedAt: new Date().toISOString().slice(0, 16) });
    this.save();
    const name = this.peer(id).name;
    clearTimeout(this.pairing.timer);
    this.swarm.leave(this.pairing.keys.topic).catch(() => {});
    this.pairing = null;
    this.joinPeer(this.peer(id));
    this.subscribeRelay();
    this.lastPairedAt = Date.now();
    log(`devices: paired with ${name}`);
    this.emit('pair', { state: 'paired', name });
    // Paired through the relay: the peer-to-peer connection comes when the two find each other. They
    // joined at about the same moment, so look again soon rather than at the next 45-second round.
    if (!conn) {
      for (const ms of [6000, 15000, 30000]) setTimeout(() => { const p = this.peer(id); if (p) this.rejoin(p); }, ms);
      this.emit('change');
      return;
    }
    // The pairing connection carries on as the pair's connection.
    this.conns.set(id, conn);
    conn.on('close', () => { if (this.conns.get(id) === conn) { this.conns.delete(id); this.watchers.delete(id); this.emit('change'); } });
    frames(conn, (f) => { const p = this.peer(id); if (p) this.onFrame(p, f); });
    send(conn, this.hello());
    send(conn, { t: 'watch', on: true });
    this.emit('change');
  }

  uniqueName(name) {
    let n = name, i = 2;
    while (this.data.peers.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }

  remove(idOrName) {
    const p = this.peer(idOrName);
    if (!p) return 'No such device.';
    this.data.peers = this.data.peers.filter((x) => x !== p);
    this.save();
    if (this.swarm) this.swarm.leave(peerTopic(Buffer.from(p.secret, 'hex'))).catch(() => {});
    this.topics.delete(p.id);
    const c = this.conns.get(p.id);
    if (c) c.destroy();
    this.conns.delete(p.id);
    this.subscribeRelay();
    log(`devices: removed ${p.name}`);
    if (!this.data.peers.length) this.stop();
    this.emit('change');
    return '';
  }

  // ---------- messages ----------

  /** A frame to a paired device: straight down the connection, or through the relay. */
  async deliver(p, f) {
    const c = this.conns.get(p.id);
    if (c && send(c, f)) return '';
    if (!this.data.relay.on) return `${p.name} isn't reachable right now, and the relay is off.`;
    return this.relaySend(p, f);
  }

  onFrame(p, f) {
    p.lastSeen = new Date().toISOString().slice(0, 16);
    if (f.t === 'hello') {
      const name = String(f.name || '').slice(0, 40), osn = String(f.os || '').slice(0, 20);
      if (osn && osn !== p.os) { p.os = osn; this.save(); this.emit('change'); }
      if (name && name !== p.name && !this.data.peers.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) { p.name = name; this.save(); this.emit('change'); }
    } else if (f.t === 'status?') {
      this.deliver(p, { t: 'status', id: f.id, ...this.statusOf() });
    } else if (f.t === 'task') {
      this.emit('task', p, { id: String(f.id || ''), description: String(f.description || 'a task').slice(0, 120), task: String(f.task || '').slice(0, 20000) });
    } else if (f.t === 'status' || f.t === 'result') {
      const w = this.pending.get(f.id);
      if (w && w.peer === p.id) { clearTimeout(w.timer); this.pending.delete(f.id); w.resolve(f); }
    } else if (f.t === 'watch') {
      // Live updates only over a direct connection; the relay would run out of messages.
      if (f.on && this.conns.get(p.id)) { this.watchers.add(p.id); this.deliver(p, { t: 'snap', events: this.snapshot() }); } else this.watchers.delete(p.id);
    } else if (f.t === 'get') {
      this.deliver(p, { t: 'snap', id: f.id, events: this.snapshot({ small: !this.conns.get(p.id) }) });
    } else if (f.t === 'snap' || f.t === 'ev') {
      if (f.t === 'snap' && f.id && this.pending.has(f.id)) { const w = this.pending.get(f.id); clearTimeout(w.timer); this.pending.delete(f.id); w.resolve(f); }
      this.emit('remote', p, f.t === 'snap' ? { snap: f.events || {} } : { e: f.e });
    } else if (f.t === 'say') {
      this.emit('say', p, String(f.text || '').slice(0, 4000), !!f.voice);
    } else if (f.t === 'said') {
      this.emit('said', p, String(f.text || '').slice(0, 4000));
    } else if (f.t === 'act') {
      if (f.action && typeof f.action === 'object') this.emit('act', p, f.action);
    } else if (f.t === 'progress') {
      const w = this.pending.get(f.id);
      if (w && w.onProgress) w.onProgress(String(f.text || '').slice(0, 200));
    }
  }

  // ---------- this device's HUD, for the others ----------

  /** A HUD event this device just showed: kept for snapshots and passed to watchers, at most every 400 ms per type. */
  mirror(e) {
    this.mirrorCache[e.type] = e;
    if (!this.watchers.size || this.mirrorTimers.has(e.type)) return;
    this.mirrorTimers.set(e.type, setTimeout(() => {
      this.mirrorTimers.delete(e.type);
      const last = this.mirrorCache[e.type];
      for (const id of this.watchers) { const c = this.conns.get(id); if (c) send(c, { t: 'ev', e: last }); else this.watchers.delete(id); }
    }, 400));
  }

  /** The latest of each mirrored event. small: for the relay, with only the end of the conversation. */
  snapshot({ small = false } = {}) {
    const out = { ...this.mirrorCache };
    if (small && out.conversation && Array.isArray(out.conversation.entries)) out.conversation = { ...out.conversation, entries: out.conversation.entries.slice(-8) };
    return out;
  }

  /** Another device's HUD, once (for when it's only reachable through the relay). */
  fetchView(idOrName) { return this.request(idOrName, { t: 'get' }, { timeout: 30000 }); }
  /** voice: said out loud here, so the answer comes back ('said') to be spoken here. */
  sayTo(idOrName, text, voice = false) { const p = this.peer(idOrName); return p ? this.deliver(p, { t: 'say', text: String(text).slice(0, 4000), voice }) : Promise.resolve('No such device.'); }
  actOn(idOrName, action) { const p = this.peer(idOrName); return p ? this.deliver(p, { t: 'act', action }) : Promise.resolve('No such device.'); }

  /** What the peer-to-peer side sees: its public address and NAT, and each pair's discovery and link. */
  diag() {
    const dht = this.swarm && this.swarm.dht;
    return {
      dht: dht ? { host: dht.host, port: dht.port, firewalled: dht.firewalled, randomized: dht.randomized, ephemeral: dht.ephemeral } : null,
      relay: this.data.relay,
      peers: this.data.peers.map((p) => {
        const c = this.conns.get(p.id);
        const seen = this.swarm ? [...this.swarm.peers.values()].filter((x) => x.publicKey && hex(x.publicKey) === p.id) : [];
        return { name: p.name, direct: !!c, remote: c && c.rawStream ? `${c.rawStream.remoteHost}:${c.rawStream.remotePort}` : '', discovered: seen.length > 0, attempts: seen.map((x) => x.attempts || 0), banned: seen.some((x) => x.banned) };
      }),
    };
  }

  /** Set by main.js: what this device is doing, for another device's "status". */
  statusOf() {
    const load = os.loadavg()[0], cores = os.cpus().length;
    return { name: this.data.name, os: OS_NAME, cpu: Math.round(Math.min(100, (load / cores) * 100)), ramUsed: +((os.totalmem() - os.freemem()) / 2 ** 30).toFixed(1), ramTotal: +(os.totalmem() / 2 ** 30).toFixed(1), ...(this.extraStatus ? this.extraStatus() : {}) };
  }

  /** Ask a paired device something and wait for the answer: { ok, ... } or { ok: false, text }. */
  request(idOrName, f, { timeout = 20000, onProgress } = {}) {
    const p = this.peer(idOrName);
    if (!p) return Promise.resolve({ ok: false, text: `No paired device called ${idOrName}. Paired: ${this.data.peers.map((x) => x.name).join(', ') || 'none'}.` });
    const id = 'r' + hex(crypto.randomBytes(6));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, text: `${p.name} didn't answer in time.` }); }, timeout);
      this.pending.set(id, { resolve: (r) => resolve({ ok: true, ...r }), timer, peer: p.id, onProgress });
      // Just after starting, the direct connection may be seconds away: wait for it a little. Later,
      // a device that isn't connected goes straight to the relay.
      const go = async () => {
        if (!this.conns.get(p.id) && this.swarm && Date.now() - this.startedAt < 20000) await new Promise((r) => { const t = setTimeout(r, 8000); const on = () => { if (this.conns.get(p.id)) { clearTimeout(t); this.off('change', on); r(); } }; this.on('change', on); });
        const err = await this.deliver(p, { ...f, id });
        if (err) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, text: err }); }
      };
      go();
    });
  }

  status(idOrName) { return this.request(idOrName, { t: 'status?' }); }
  ask(idOrName, description, task, onProgress) {
    return this.request(idOrName, { t: 'task', description: String(description || 'a task').slice(0, 120), task: String(task || '').slice(0, 20000) }, { timeout: 45 * 60000, onProgress });
  }
  /** Back to the device that sent a task. */
  reply(p, id, f) { return this.deliver(p, { ...f, id }); }

  // ---------- the relay (ntfy) ----------

  async relaySend(p, f) {
    const key = relayKey(Buffer.from(p.secret, 'hex'));
    const mid = hex(crypto.randomBytes(8));
    const text = seal(key, { from: this.id, to: p.id, ts: Date.now(), mid, f });
    const n = Math.ceil(text.length / RELAY_PART);
    const url = `${this.data.relay.url}/${relayTopic(Buffer.from(p.secret, 'hex'), p.id)}`;
    try {
      for (let i = 0; i < n; i++) {
        const r = await this.fetch(url, { method: 'POST', body: JSON.stringify({ m: mid, i, n, d: text.slice(i * RELAY_PART, (i + 1) * RELAY_PART) }), signal: AbortSignal.timeout(15000) });
        if (r.status === 429) return 'The relay\'s daily limit is used up. Try again tomorrow, or set your own relay in Settings › Devices.';
        if (!r.ok) return `The relay refused the message (${r.status}).`;
      }
      return '';
    } catch (e) { return `Couldn't reach the relay: ${e.message}`; }
  }

  /** One long-lived connection to the relay, listening for messages to this device from any pair. */
  subscribeRelay() {
    if (this.relayAbort) this.relayAbort.abort();
    this.relayAbort = null;
    if (!this.swarm || !this.data.relay.on || !this.data.peers.length) return;
    const ab = new AbortController();
    this.relayAbort = ab;
    const topics = this.data.peers.map((p) => relayTopic(Buffer.from(p.secret, 'hex'), this.id));
    this.relayStream(`${this.data.relay.url}/${topics.join(',')}/json?since=5m`, ab.signal, (topic, message) => this.onRelay(topic, message));
  }

  /** Keep a relay subscription open until signal aborts, reconnecting with a growing wait. */
  async relayStream(url, signal, onMessage) {
    let wait = 2000;
    while (!signal.aborted) {
      try {
        const r = await this.fetch(url, { signal });
        if (!r.ok || !r.body) throw new Error(`status ${r.status}`);
        wait = 2000;
        const reader = r.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line); if (m.event === 'message') onMessage(m.topic, m.message); } catch {}
          }
        }
      } catch (e) {
        if (signal.aborted) return;
        log(`devices: relay: ${String(e.message || e).slice(0, 80)}; again in ${wait / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 120000);
    }
  }

  onRelay(topic, message) {
    const p = this.data.peers.find((x) => relayTopic(Buffer.from(x.secret, 'hex'), this.id) === topic);
    if (!p) return;
    let part;
    try { part = JSON.parse(message); } catch { return; }
    if (!part || typeof part.m !== 'string' || !Number.isInteger(part.i) || !Number.isInteger(part.n) || part.n > 100) return;
    if (this.seen.has(part.m)) return;
    const got = this.parts.get(part.m) || { n: part.n, d: [], at: Date.now() };
    got.d[part.i] = String(part.d || '');
    this.parts.set(part.m, got);
    if (got.d.filter((x) => x !== undefined).length < got.n) return;
    this.parts.delete(part.m);
    for (const [k, v] of this.parts) if (Date.now() - v.at > RELAY_MAX_AGE) this.parts.delete(k);
    const env = open(relayKey(Buffer.from(p.secret, 'hex')), got.d.join(''));
    // Sealed with the pair's key, from that device, to this one, recent and not seen before.
    if (!env || env.from !== p.id || env.to !== this.id || env.mid !== part.m || Math.abs(Date.now() - env.ts) > RELAY_MAX_AGE || !env.f || typeof env.f.t !== 'string') return;
    this.seen.add(part.m);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    this.onFrame(p, env.f);
  }
}

module.exports = { Devices, normCode, newCode, pairKeys, pairProof, seal, open, relayTopic, relayKey, peerTopic, pairRelayTopic, pairRelayKey };
