// Talk to JARVIS from your phone over Telegram. Long-polls the Bot API (no
// public URL needed), accepts text and voice notes from ONE allowed chat and
// replies with text and, optionally, a voice note.
//
// Security: updates from any other chat are ignored. With no chat id
// configured, the first sender is told their id and nothing is executed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { log, run, which, clean, paths } = require('./util');

class Telegram extends EventEmitter {
  constructor(cfg, orch) {
    super();
    this.cfg = cfg;
    this.orch = orch;
    this.token = cfg.telegramToken;
    this.chat = Number(cfg.telegramChatId) || 0;
    this.offset = 0;
    this.queue = [];
    this.dispatching = false;
    this.ffmpeg = which('ffmpeg');
    this.status = 'off';
  }

  get api() { return `https://api.telegram.org/bot${this.token}`; }

  async start() {
    if (!this.token || this.running) return;
    this.running = true;
    this.orch.on('telegram-reply', (chat, text) => this.reply(chat, text));
    this.orch.on('notice', (text) => { if (this.chat) this.send(this.chat, text); });
    const me = await this.call('getMe');
    if (me && me.ok === false && (me.error_code === 401 || me.error_code === 404)) {
      log('telegram: token rejected');
      this.setStatus('invalid token');
      this.running = false;
      return;
    }
    const name = (me && me.result && me.result.username) || '?';
    log(`telegram: connected as @${name}, chat lock=${this.chat}`);
    this.setStatus(`@${name}`);
    this.poll();
  }

  setStatus(s) { this.status = s; this.emit('status', s); }

  async poll() {
    while (this.running) {
      const json = await this.call('getUpdates', { timeout: 25, offset: this.offset, allowed_updates: JSON.stringify(['message']) }, 40000);
      if (json && json.ok === false) {
        if (json.error_code === 401 || json.error_code === 404) {
          // Bad token: retrying will never work. Stop instead of hammering the API.
          log('telegram: token rejected, polling stopped');
          this.setStatus('invalid token');
          this.running = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of (json && json.result) || []) {
        this.offset = u.update_id + 1;
        if (u.message) this.handle(u.message);
      }
      await new Promise((r) => setTimeout(r, json ? 200 : 5000));
    }
  }

  async handle(m) {
    const chatId = m.chat && m.chat.id;
    if (!chatId) return;
    const from = (m.from && m.from.username) || '?';
    if (!this.chat) {
      log(`telegram: unlocked; first message from @${from} chat ${chatId}`);
      this.send(chatId, `JARVIS here. This chat id is ${chatId}. Enter it in JARVIS Settings → Telegram (or run scripts/telegram-setup.sh) to lock me to you.`);
      return;
    }
    if (chatId !== this.chat) { log(`telegram: ignored chat ${chatId} (@${from})`); return; }
    if (m.text) {
      log(`telegram: text '${m.text.slice(0, 80)}'`);
      this.enqueue(chatId, m.text);
    } else if (m.voice && m.voice.file_id) {
      const text = await this.transcribe(m.voice.file_id);
      if (text) { this.send(chatId, `🎤 “${text}”`); this.enqueue(chatId, text); }
      else this.send(chatId, `I couldn't make out that voice note, ${this.cfg.honorific}.`);
    }
  }

  enqueue(chat, text) { this.queue.push([chat, text]); this.dispatch(); }

  // Waits for JARVIS to be free, checking every half second, but only while messages are waiting.
  dispatch() {
    if (this.queue.length && !this.ticker) this.ticker = setInterval(() => this.dispatch(), 500);
    else if (!this.queue.length && this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.dispatching || !this.queue.length || !this.orch.isIdle) return;
    const [chat, text] = this.queue.shift();
    this.dispatching = true;
    this.call('sendChatAction', { chat_id: chat, action: 'typing' });
    this.orch.handle(text, { kind: 'telegram', chat });
  }

  reply(chat, text) {
    this.dispatching = false;
    const t = String(text || '').trim();
    if (!t) return;
    this.send(chat, t);
    if (this.cfg.telegramVoiceReplies) this.sendVoice(chat, clean(t));
  }

  send(chat, text) { return this.call('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000) }); }

  async sendVoice(chat, text) {
    if (!this.ffmpeg || !fs.existsSync(paths.edgeTTS)) return;
    const base = path.join(os.tmpdir(), `tg-${Date.now()}`);
    try {
      const r = await run(paths.edgeTTS, ['--voice', this.cfg.edgeVoice, '--text', text.slice(0, 1500), '--write-media', base + '.mp3'], { timeout: 30000 });
      if (r.code !== 0) return;
      const c = await run(this.ffmpeg, ['-y', '-loglevel', 'error', '-i', base + '.mp3', '-c:a', 'libopus', '-b:a', '32k', base + '.ogg'], { timeout: 30000 });
      if (c.code !== 0) { log(`telegram: ogg convert failed ${c.err.slice(0, 120)}`); return; }
      const form = new FormData();
      form.append('chat_id', String(chat));
      form.append('voice', new Blob([fs.readFileSync(base + '.ogg')], { type: 'audio/ogg' }), 'jarvis.ogg');
      await fetch(`${this.api}/sendVoice`, { method: 'POST', body: form });
    } catch (e) { log(`telegram: voice reply failed ${e.message}`); } finally {
      fs.rm(base + '.mp3', () => {}); fs.rm(base + '.ogg', () => {});
    }
  }

  async transcribe(fileId) {
    if (!this.ffmpeg) return '';
    const info = await this.call('getFile', { file_id: fileId });
    const fp = info && info.result && info.result.file_path;
    if (!fp) return '';
    const base = path.join(os.tmpdir(), `tg-in-${Date.now()}`);
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${fp}`);
      fs.writeFileSync(base + '.oga', Buffer.from(await res.arrayBuffer()));
      const c = await run(this.ffmpeg, ['-y', '-loglevel', 'error', '-i', base + '.oga', '-ar', '16000', '-ac', '1', base + '.wav'], { timeout: 30000 });
      if (c.code !== 0) return '';
      return await this.orch.ears.transcribeFile(base + '.wav');
    } catch { return ''; } finally {
      fs.rm(base + '.oga', () => {}); setTimeout(() => fs.rm(base + '.wav', () => {}), 45000);
    }
  }

  async call(method, params = {}, timeout = 15000) {
    try {
      const res = await fetch(`${this.api}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeout),
      });
      const json = await res.json();
      if (json.ok === false) log(`telegram: ${method}: ${json.description}`);
      return json;
    } catch (e) {
      if (method !== 'getUpdates' || !/abort|timeout/i.test(e.message)) log(`telegram: ${method} failed: ${e.message}`);
      return null;
    }
  }

  stop() { this.running = false; clearInterval(this.ticker); this.ticker = null; }
}

module.exports = Telegram;
