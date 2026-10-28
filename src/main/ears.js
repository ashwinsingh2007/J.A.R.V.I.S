// Ears: the Swift sidecar (microphone with echo cancellation + Apple
// on-device speech) and, optionally, ElevenLabs Scribe realtime.
//
// With sttEngine "elevenlabs" the cloud only hears you while JARVIS is awake;
// while asleep the on-device recogniser listens for "wake up", so nothing is
// streamed (or billed) all day.
//
// events: 'ready', 'text' (text, final), 'level' (0..1), 'restarted',
//         'devices' (list), 'error' (msg)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { log, jsonLines } = require('./util');

class Ears extends EventEmitter {
  constructor(cfg, binPath, vocabulary) {
    super();
    this.cfg = cfg;
    this.bin = binPath;
    this.vocab = vocabulary;
    this.proc = null;
    this.devices = [];
    this.fileJobs = new Map();
    this.cloudWanted = false;
    this.ws = null;
    this.cloud = { committed: '', partial: '', dropUntilCommit: false };
  }

  get engineLabel() { return this.cfg.sttEngine === 'elevenlabs' ? 'elevenlabs scribe (awake) · apple (asleep)' : 'apple on-device'; }

  start() {
    if (!fs.existsSync(this.bin)) { this.emit('error', `Speech sidecar missing at ${this.bin}. Run npm run ears.`); return; }
    const args = ['--locale', this.cfg.speechLocale, '--vocab', this.vocab.join('|'), '--engine', this.cfg.appleSpeech === 'accurate' ? 'analyzer' : 'dictation'];
    const p = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    jsonLines(p.stdout, (o) => this.onSidecar(o));
    p.stderr.on('data', (d) => log(`ears stderr: ${String(d).slice(0, 200)}`));
    p.on('exit', (code, sig) => {
      log(`ears: sidecar exited (${code ?? sig})`);
      if (this.proc === p) { this.proc = null; if (!this.stopping) setTimeout(() => this.start(), 2000); }
    });
  }

  stop() { this.stopping = true; this.closeCloud(); if (this.proc) this.proc.kill(); }

  /** Language or recogniser changed: start a new sidecar; mute, standby and input device carry over. */
  restart() {
    const p = this.proc;
    this.proc = null;
    if (p) p.kill();
    this.start();
  }

  send(obj) { if (this.proc) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  onSidecar(o) {
    switch (o.type) {
      case 'ready':
        log('ears: ready');
        if (this.inputId != null) this.send({ cmd: 'set_input', id: this.inputId });
        if (this.isMuted) this.send({ cmd: 'mute', on: true });
        if (this.isSuspended) this.send({ cmd: 'suspend' });
        if (this.echoOn === false) this.send({ cmd: 'echo', on: false });
        this.emit('ready');
        break;
      case 'text': if (!this.cloudActive) this.emit('text', o.text, !!o.final); break;
      case 'level': this.emit('level', o.v); break;
      case 'restarted': if (!this.cloudActive) this.emit('restarted'); break;
      case 'pcm': this.sendCloudAudio(o.b64); break;
      case 'devices': this.devices = o.list || []; this.emit('devices', this.devices); break;
      case 'file_text': { const j = this.fileJobs.get(o.id); if (j) { this.fileJobs.delete(o.id); j(o.text || ''); } break; }
      case 'log': log(`ears: ${o.msg}`); break;
      case 'error': log(`ears error: ${o.msg}`); this.emit('error', o.msg); break;
    }
  }

  // ---------- commands ----------

  reset() {
    this.send({ cmd: 'reset' });
    if (this.cloudActive) {
      this.cloud.committed = '';
      this.cloud.partial = '';
      // Whatever is still in the current cloud segment belongs to before the reset.
      this.cloud.dropUntilCommit = true;
      clearTimeout(this.dropTimer);
      this.dropTimer = setTimeout(() => { this.cloud.dropUntilCommit = false; }, 1500);
      this.sendCloud({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 });
    }
  }
  mute(on) { this.isMuted = on; this.send({ cmd: 'mute', on }); }
  armed(on) { this.send({ cmd: 'armed', on }); }
  /** Echo cancellation in the sidecar: on while JARVIS talks or music plays, off otherwise (it costs CPU). */
  echo(on) { if (this.echoOn === on) return; this.echoOn = on; log(`ears: echo cancellation ${on ? 'on' : 'off'}`); this.send({ cmd: 'echo', on }); }
  suspend() { this.isSuspended = true; this.send({ cmd: 'suspend' }); this.setAwake(false); }
  resume() { this.isSuspended = false; this.send({ cmd: 'resume' }); }
  listDevices() { this.send({ cmd: 'devices' }); }
  setInput(id) { this.inputId = id; this.send({ cmd: 'set_input', id }); }

  transcribeFile(file) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.fileJobs.set(id, resolve);
      this.send({ cmd: 'transcribe_file', id, path: file });
      setTimeout(() => { if (this.fileJobs.delete(id)) resolve(''); }, 40000);
    });
  }

  /** Awake/asleep from the orchestrator: switches the cloud stream on/off. */
  setAwake(on) {
    const want = on && this.cfg.sttEngine === 'elevenlabs' && !!this.cfg.elevenLabsApiKey;
    if (want === this.cloudWanted) return;
    this.cloudWanted = want;
    if (want) this.openCloud(); else this.closeCloud();
  }

  get cloudActive() { return this.cloudWanted && this.ws && this.ws.readyState === 1; }

  // ---------- ElevenLabs Scribe realtime ----------

  async openCloud() {
    if (this.ws || !this.cloudWanted) return;
    try {
      // Single-use token: the API key never goes into a URL.
      const r = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST', headers: { 'xi-api-key': this.cfg.elevenLabsApiKey }, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`token ${r.status} ${(await r.text()).slice(0, 120)}`);
      const { token } = await r.json();
      if (!this.cloudWanted) return;
      const q = new URLSearchParams({
        model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'vad',
        language_code: this.cfg.speechLocale.split('-')[0], token,
      });
      const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`);
      this.ws = ws;
      this.cloud = { committed: '', partial: '', dropUntilCommit: false };
      ws.onopen = () => { log('ears: elevenlabs stream open'); this.send({ cmd: 'pcm', on: true }); };
      ws.onmessage = (m) => this.onCloud(m.data);
      ws.onerror = (e) => log(`ears: elevenlabs error ${e.message || ''}`);
      ws.onclose = (e) => {
        log(`ears: elevenlabs closed (${e.code} ${e.reason || ''})`);
        if (this.ws === ws) this.ws = null;
        this.send({ cmd: 'pcm', on: false });
        if (this.cloudWanted) setTimeout(() => this.openCloud(), 1500);
      };
    } catch (e) {
      log(`ears: elevenlabs unavailable (${e.message}); using on-device speech`);
      this.emit('error', 'ElevenLabs transcription failed; using on-device speech.');
      this.ws = null;
    }
  }

  closeCloud() {
    this.send({ cmd: 'pcm', on: false });
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch {}
  }

  sendCloud(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  sendCloudAudio(b64) { this.sendCloud({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 }); }

  onCloud(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const c = this.cloud;
    switch (m.message_type) {
      case 'partial_transcript':
        if (c.dropUntilCommit) return;
        c.partial = m.text || '';
        break;
      case 'committed_transcript':
        if (c.dropUntilCommit) { c.dropUntilCommit = false; c.partial = ''; return; }
        c.committed = [c.committed, m.text || ''].filter(Boolean).join(' ');
        c.partial = '';
        break;
      case 'session_started': return;
      default:
        if (m.error) log(`ears: elevenlabs ${m.message_type}: ${m.error}`);
        return;
    }
    const text = [c.committed, c.partial].filter(Boolean).join(' ').trim();
    if (text) this.emit('text', text, m.message_type === 'committed_transcript');
  }
}

/** Words the recogniser should favour: wake words, project folder names, tool names. */
function vocabulary(cfg) {
  const words = new Set(['Claude', 'Claude Code', 'session', 'terminal', 'iTerm', 'Gmail', 'GitHub']);
  for (const base of ['Projects', 'Projects/personal']) {
    try { for (const n of fs.readdirSync(path.join(os.homedir(), base))) if (!n.startsWith('.')) words.add(n.replace(/-/g, ' ')); } catch {}
  }
  return [...cfg.wakeWords.map((w) => w[0].toUpperCase() + w.slice(1)), ...[...words].slice(0, 120)];
}

module.exports = { Ears, vocabulary };
