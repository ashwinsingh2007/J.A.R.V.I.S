// Background music. Stations:
//   instrumental – built-in calm radio streams + local "Office Lounge" tracks
//   popular      – most-voted stations for a country from radio-browser.info
//   favourite    – stations found by voice search ("play radio mirchi"), kept in config
// Radio streams go through a tiny proxy on 127.0.0.1 that strips the ICY
// metadata and reports the song title. Volume ducks while JARVIS listens or speaks.
//
// events: 'change' (playing, station, title), 'stations'
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const EventEmitter = require('events');
const C = require('./config');
const { log, paths } = require('./util');

const BUILT_IN = [
  { id: 'lofi', name: 'Lofi Beats', note: 'chill lo-fi instrumentals · radio', stream: 'https://stream.laut.fm/lofi' },
  { id: 'ambient', name: 'Ambient Sleeping Pill', note: 'soft ambient, no beats · radio', stream: 'https://radio.stereoscenic.com/asp-h' },
  { id: 'chillhop', name: 'Chillhop', note: 'instrumental hip-hop, café feel · radio', stream: 'https://streams.fluxfm.de/Chillhop/mp3-128/streams.fluxfm.de/' },
  { id: 'smoothjazz', name: 'Smooth Jazz', note: 'mostly instrumental jazz · radio', stream: 'https://smoothjazz.cdnstream1.com/2585_128.mp3' },
  { id: 'swissjazz', name: 'Radio Swiss Jazz', note: 'calm jazz, few vocals · radio', stream: 'https://stream.srg-ssr.ch/m/rsj/mp3_128' },
  { id: 'classical', name: 'Radio Swiss Classic', note: 'light classical · radio', stream: 'https://stream.srg-ssr.ch/m/rsc_de/mp3_128' },
  { id: 'lounge', name: 'Office Lounge', note: 'light jazz-pop instrumentals · on this Mac', stream: null },
].map((s) => ({ ...s, group: 'instrumental' }));

const CREDIT = 'Office Lounge music by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0. Radio directory: radio-browser.info.';
const RB = 'https://de1.api.radio-browser.info/json/stations';

class Music extends EventEmitter {
  constructor(cfg, audio) {
    super();
    this.cfg = cfg;
    this.audio = audio;
    this.favourites = (cfg.radioFavourites || []).map((d) => ({ id: d.id, name: d.name, note: d.note || 'radio', stream: d.url, group: 'favourite' }));
    this.popular = [];
    this.stations = [];
    this.index = 0;
    this.playing = false;
    this.nowPlaying = '';
    this.baseVolume = cfg.musicVolume;
    this.ducked = false;
    this.playlist = [];
    this.track = 0;
    this.rebuild();
    this.restore(cfg.musicStation);
    this.proxy = new IcyProxy((title) => {
      if (!this.playing || !title || title === this.nowPlaying) return;
      this.nowPlaying = title;
      this.emit('change', true, this.current, title);
    });
    audio.on('music-playing', () => { log(`music: audio started (${this.current.name})`); if (this.pendingResult) { const r = this.pendingResult; this.pendingResult = null; r(true); } });
    audio.on('music-error', (msg) => {
      log(`music: ${this.current.name} error ${msg}`);
      if (this.pendingResult) { const r = this.pendingResult; this.pendingResult = null; r(false); }
    });
    audio.on('music-ended', () => this.advanceTrack());
  }

  get current() { return this.stations[Math.min(this.index, this.stations.length - 1)]; }
  get volume() { return this.ducked ? this.baseVolume * 0.2 : this.baseVolume; }
  static get credit() { return CREDIT; }

  toggle() { this.playing ? this.stop() : this.play(); }

  play(i, onResult) {
    if (i !== undefined) this.index = ((i % this.stations.length) + this.stations.length) % this.stations.length;
    const st = this.current;
    this.nowPlaying = '';
    if (st.stream) {
      this.start(/\.m3u8(\?|$)/i.test(st.stream) ? st.stream : this.proxy.url(st.stream), st, onResult);
    } else {
      let files = [];
      try { files = fs.readdirSync(paths.music).filter((f) => f.toLowerCase().endsWith('.mp3')); } catch {}
      if (!files.length) { log(`music: no tracks in ${paths.music}`); onResult && onResult(false); return; }
      this.playlist = files.sort(() => Math.random() - 0.5).map((f) => path.join(paths.music, f));
      this.track = 0;
      this.start(pathToFileURL(this.playlist[0]).href, st, onResult);
      this.nowPlaying = path.basename(this.playlist[0], '.mp3');
    }
    this.playing = true;
    C.save({ musicStation: st.id });
    log(`music: playing ${st.name}`);
    this.emit('change', true, st, this.nowPlaying);
  }

  start(url, st, onResult) {
    clearTimeout(this.watchdog);
    this.pendingResult = null;
    if (onResult) {
      this.pendingResult = onResult;
      // No audio within 10 s counts as a failure.
      this.watchdog = setTimeout(() => {
        if (this.pendingResult === onResult) { this.pendingResult = null; log(`music: ${st.name} did not start`); onResult(false); }
      }, 10000);
    }
    this.audio.playMusic(url, this.volume);
  }

  next() { this.play(this.index + 1); }
  nextTrack() { if (!this.current.stream && this.playing) this.advanceTrack(); else this.next(); }

  advanceTrack() {
    if (this.current.stream || !this.playlist.length || !this.playing) return;
    this.track = (this.track + 1) % this.playlist.length;
    this.audio.playMusic(pathToFileURL(this.playlist[this.track]).href, this.volume);
    this.nowPlaying = path.basename(this.playlist[this.track], '.mp3');
    this.emit('change', true, this.current, this.nowPlaying);
  }

  stop() {
    clearTimeout(this.watchdog);
    this.audio.stopMusic();
    this.playing = false;
    this.nowPlaying = '';
    this.emit('change', false, this.current, '');
  }

  select(id) { const i = this.stations.findIndex((s) => s.id === id); if (i >= 0) this.play(i); }
  restore(id) { const i = this.stations.findIndex((s) => s.id === id); if (i >= 0) this.index = i; }

  duck(on) { if (on === this.ducked) return; this.ducked = on; this.audio.setMusicVolume(this.volume); }
  setVolume(v) { this.baseVolume = Math.max(0, Math.min(1, v)); this.audio.setMusicVolume(this.volume); }

  // ---------- radio directory ----------

  async loadDirectory() {
    const found = await rbFetch(`${RB}/search?countrycode=${this.cfg.radioCountry}&order=votes&reverse=true&limit=15&hidebroken=true`);
    this.popular = found.map((f) => ({ id: f.id, name: f.name, note: `${f.country} · radio`, stream: f.url, group: 'popular' }));
    this.rebuild();
  }

  /** "play radio mirchi" → search, try matches until one plays, remember it. */
  async playSearch(query) {
    const q = encodeURIComponent(query);
    let found = await rbFetch(`${RB}/search?name=${q}&countrycode=${this.cfg.radioCountry}&order=votes&reverse=true&limit=8&hidebroken=true`);
    if (!found.length) found = await rbFetch(`${RB}/search?name=${q}&order=votes&reverse=true&limit=8&hidebroken=true`);
    for (const f of found.slice(0, 6)) {
      const st = { id: f.id, name: f.name, note: `${f.country} · radio`, stream: f.url, group: 'favourite' };
      if (!this.stations.some((s) => s.id === st.id)) this.stations.unshift(st);
      this.index = this.stations.findIndex((s) => s.id === st.id);
      const ok = await new Promise((r) => this.play(undefined, r));
      if (ok) {
        if (!this.favourites.some((s) => s.id === st.id)) {
          this.favourites = [st, ...this.favourites].slice(0, 12);
          C.save({ radioFavourites: this.favourites.map((s) => ({ id: s.id, name: s.name, url: s.stream, note: s.note })) });
        }
        this.rebuild();
        return f.name;
      }
      this.stations = this.stations.filter((s) => s.id !== st.id || this.favourites.some((x) => x.id === st.id));
    }
    this.stop();
    return null;
  }

  rebuild() {
    const keep = this.stations.length ? this.current.id : null;
    const seen = new Set();
    this.stations = [...this.favourites, ...BUILT_IN, ...this.popular].filter((s) => !seen.has(s.id) && seen.add(s.id));
    const i = keep ? this.stations.findIndex((s) => s.id === keep) : -1;
    this.index = i >= 0 ? i : 0;
    this.emit('stations');
  }
}

async function rbFetch(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'JARVIS-voice/0.2' }, signal: AbortSignal.timeout(10000) });
    const arr = await r.json();
    return arr.map((s) => ({
      id: 'rb-' + (s.stationuuid || Math.random().toString(36).slice(2)),
      name: String(s.name || '').trim(), url: s.url_resolved || s.url, country: s.countrycode || '',
    })).filter((s) => s.name && s.url);
  } catch (e) {
    log(`music: radio-browser failed ${e.message}`);
    return [];
  }
}

/** Local-only stream proxy: strips ICY metadata, reports "Artist - Song". */
class IcyProxy {
  constructor(onTitle) {
    this.onTitle = onTitle;
    this.port = 0;
    // Random per run, so no other local process or web page can use the proxy.
    this.key = require('crypto').randomBytes(12).toString('hex');
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; log(`music: stream proxy on 127.0.0.1:${this.port}`); });
  }

  url(stream) { return `http://127.0.0.1:${this.port}/s?u=${encodeURIComponent(stream)}&k=${this.key}&n=${Date.now()}`; }

  async handle(req, res) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    const u = q.get('u');
    if (q.get('k') !== this.key) { res.writeHead(403); res.end(); return; }
    if (!u || !/^https?:\/\//.test(u)) { res.writeHead(400); res.end(); return; }
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      const up = await fetch(u, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'JARVIS-voice/0.2' }, signal: abort.signal });
      if (!up.ok || !up.body) { res.writeHead(up.status || 502); res.end(); return; }
      res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Cache-Control': 'no-cache' });
      const metaint = parseInt(up.headers.get('icy-metaint') || '0', 10);
      let toMeta = metaint, metaLen = -1, meta = [];
      for await (const chunk of up.body) {
        if (!metaint) { res.write(chunk); continue; }
        let buf = Buffer.from(chunk);
        while (buf.length) {
          if (metaLen < 0 && toMeta > 0) {
            const n = Math.min(toMeta, buf.length);
            res.write(buf.subarray(0, n));
            buf = buf.subarray(n);
            toMeta -= n;
          } else if (metaLen < 0) {
            metaLen = buf[0] * 16;
            buf = buf.subarray(1);
            meta = [];
            if (metaLen === 0) { metaLen = -1; toMeta = metaint; }
          } else {
            const n = Math.min(metaLen, buf.length);
            meta.push(buf.subarray(0, n));
            buf = buf.subarray(n);
            metaLen -= n;
            if (metaLen === 0) {
              const m = /StreamTitle='(.*?)';/.exec(Buffer.concat(meta).toString('utf8'));
              if (m && m[1].trim()) this.onTitle(m[1].trim());
              metaLen = -1;
              toMeta = metaint;
            }
          }
        }
      }
      res.end();
    } catch (e) {
      if (!abort.signal.aborted) log(`music: proxy ${e.message}`);
      try { res.end(); } catch {}
    }
  }
}

module.exports = Music;
