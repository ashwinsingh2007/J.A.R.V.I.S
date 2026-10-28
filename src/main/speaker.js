// Sentence-queued text to speech. Engines:
//   kokoro     – local Kokoro-82M via a persistent Python worker (offline)
//   elevenlabs – ElevenLabs API (needs a key and internet)
//   edge       – Microsoft Edge neural voices via edge-tts (internet, free)
//   native     – macOS `say` (always available fallback)
// Every engine writes an audio file; the hidden audio window plays it.
// Sentences are synthesised ahead while the previous one plays.
//
// events: 'start', 'finish', 'level' (0..1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { log, run, jsonLines, clean, paths, env } = require('./util');

const TMP = path.join(os.tmpdir(), 'jarvis-tts');

class Speaker extends EventEmitter {
  constructor(cfg, audio) {
    super();
    this.cfg = cfg;
    this.audio = audio;
    this.queue = [];             // sentences waiting
    this.ready = new Map();      // sentence -> file
    this.voiceFor = new Map();   // sentence -> another device's agent's voice, for its answers
    this.inflight = new Set();
    this.playing = false;
    this.generation = 0;
    this.kokoro = null;
    this.kokoroJobs = new Map();
    fs.mkdirSync(TMP, { recursive: true });
    this.engine = this.pickEngine(cfg.ttsEngine);
    log(`tts: engine ${this.engine}`);
    audio.on('tts-ended', () => this.finishedOne(false));
    audio.on('tts-level', (v) => this.emit('level', v));
  }

  get isSpeaking() { return this.playing || this.queue.length > 0 || this.inflight.size > 0; }
  get label() {
    return { kokoro: `kokoro ${this.cfg.kokoroVoice}`, elevenlabs: 'elevenlabs', edge: `edge ${this.cfg.edgeVoice}`, native: `macos ${this.cfg.nativeVoice}` }[this.engine];
  }

  pickEngine(want) {
    if (want === 'elevenlabs' && this.cfg.elevenLabsApiKey) return 'elevenlabs';
    if (want === 'kokoro' && this.startKokoro()) return 'kokoro';
    if ((want === 'edge' || want === 'kokoro') && fs.existsSync(paths.edgeTTS)) return 'edge';
    return 'native';
  }

  /** Voice settings changed: switch engine now; voice and speed are read per sentence anyway. */
  reconfigure() {
    this.stop();
    const want = this.cfg.ttsEngine;
    if (want === 'kokoro' && this.kokoro) { this.engine = 'kokoro'; }
    else {
      if (this.kokoro && want !== 'kokoro') { const k = this.kokoro; this.engine = want; k.kill(); }
      this.engine = this.pickEngine(want);
    }
    log(`tts: engine ${this.engine}`);
  }

  /** voice: another voice for this sentence ({ kokoroVoice, kokoroSpeed, edgeVoice, nativeVoice }),
   *  for an answer from another device's agent. */
  speak(sentence, voice) {
    const s = clean(sentence);
    if (!s) return;
    if (voice) this.voiceFor.set(s, voice);
    this.queue.push(s);
    this.pump();
  }

  /** A voice setting for this sentence: its own voice if it has one, else this device's. */
  v(s, key) { const o = this.voiceFor.get(s); return (o && o[key] !== undefined) ? o[key] : this.cfg[key]; }

  stop() {
    this.generation++;
    this.queue = [];
    this.voiceFor.clear();
    this.audio.stopTTS();
    for (const f of this.ready.values()) fs.rm(f, () => {});
    this.ready.clear();
    this.finishedOne(true);
  }

  pump() {
    for (const s of this.queue) {
      if (this.inflight.size >= 4) break;
      if (!this.ready.has(s) && !this.inflight.has(s)) this.synth(s);
    }
    if (this.playing || !this.queue.length) return;
    const next = this.queue[0];
    const file = this.ready.get(next);
    if (!file) return;
    this.queue.shift();
    this.ready.delete(next);
    this.voiceFor.delete(next);
    this.playing = true;
    if (!this.started) { this.started = true; this.emit('start'); }
    this.audio.playTTS(file);
  }

  async synth(s) {
    this.inflight.add(s);
    const gen = this.generation;
    const t = Date.now();
    let file = null, err = '';
    try {
      file = await this[`synth_${this.engine}`](s);
    } catch (e) { err = String(e.message || e); }
    this.inflight.delete(s);
    if (gen !== this.generation) { if (file) fs.rm(file, () => {}); return; }
    if (file) {
      log(`timing: ${this.engine} synth ${Date.now() - t} ms for ${s.length} chars`);
      this.ready.set(s, file);
    } else if (this.engine !== 'native') {
      log(`tts: ${this.engine} failed (${err.slice(0, 200)}), falling back to macOS voice`);
      this.engine = 'native';
      this.synth(s);
      return;
    } else {
      log(`tts: native failed (${err}); skipping sentence`);
      const i = this.queue.indexOf(s);
      if (i >= 0) this.queue.splice(i, 1);
      if (!this.queue.length && !this.inflight.size && !this.playing) this.finishedOne(false);
    }
    this.pump();
  }

  tmp(ext) { return path.join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`); }

  // ---------- engines ----------

  async synth_native(s) {
    const out = this.tmp('wav');
    const r = await run('/usr/bin/say', ['-v', this.v(s, 'nativeVoice'), '--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, s], { timeout: 30000 });
    if (r.code !== 0) {
      // Voice not installed: system default voice.
      const r2 = await run('/usr/bin/say', ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, s], { timeout: 30000 });
      if (r2.code !== 0) throw new Error(r2.err);
    }
    return out;
  }

  async synth_edge(s) {
    const out = this.tmp('mp3');
    const r = await run(paths.edgeTTS, ['--voice', this.v(s, 'edgeVoice'), '--text', s, '--write-media', out], { timeout: 20000 });
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(r.err || 'edge-tts failed');
    return out;
  }

  async synth_elevenlabs(s) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.cfg.elevenLabsVoiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.cfg.elevenLabsApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: s, model_id: this.cfg.elevenLabsModel }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    const out = this.tmp('mp3');
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }

  startKokoro() {
    const script = path.join(paths.scripts, 'kokoro_server.py');
    if (!fs.existsSync(paths.python) || !fs.existsSync(script) || !fs.existsSync(path.join(paths.models, 'kokoro-v1.0.onnx'))) {
      log('tts: kokoro not installed (run ./setup.sh)');
      return false;
    }
    const p = spawn(paths.python, ['-u', script], { env: env(), stdio: ['pipe', 'pipe', 'ignore'] });
    this.kokoro = p;
    jsonLines(p.stdout, (o) => {
      if (o.ready) { log(`tts: kokoro ready in ${o.load_ms} ms`); return; }
      const job = this.kokoroJobs.get(o.id);
      if (!job) return;
      this.kokoroJobs.delete(o.id);
      o.ok ? job.resolve(job.out) : job.reject(new Error(o.error || 'kokoro failed'));
    });
    p.on('exit', () => {
      log('tts: kokoro worker exited');
      this.kokoro = null;
      for (const j of this.kokoroJobs.values()) j.reject(new Error('kokoro exited'));
      this.kokoroJobs.clear();
      if (this.engine === 'kokoro') this.engine = fs.existsSync(paths.edgeTTS) ? 'edge' : 'native';
    });
    return true;
  }

  synth_kokoro(s) {
    return new Promise((resolve, reject) => {
      if (!this.kokoro) return reject(new Error('kokoro not running'));
      const id = Math.random().toString(36).slice(2);
      const out = this.tmp('wav');
      this.kokoroJobs.set(id, { resolve, reject, out });
      this.kokoro.stdin.write(JSON.stringify({ id, text: s, voice: this.v(s, 'kokoroVoice'), speed: this.v(s, 'kokoroSpeed'), out }) + '\n');
    });
  }

  // ---------- playback bookkeeping ----------

  finishedOne(stopped) {
    this.playing = false;
    if (stopped || (!this.queue.length && !this.inflight.size)) {
      if (this.started) { this.started = false; this.emit('level', 0); this.emit('finish'); }
    } else {
      this.pump();
    }
  }

  shutdown() { if (this.kokoro) this.kokoro.kill(); }
}

module.exports = Speaker;
