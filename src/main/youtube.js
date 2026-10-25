// YouTube in a small floating "JARVIS · YouTube" window. It is plain
// youtube.com, so YouTube's own player, ads and terms apply. The window can
// be hidden while audio keeps playing.
//
// events: 'change' (playing, title)
const EventEmitter = require('events');
const { BrowserWindow, screen } = require('electron');
const { log } = require('./util');

const q = (s) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(s);
const PRESETS = [
  { id: 'lofigirl', name: 'Lofi Girl', note: '24/7 lofi hip-hop live', url: 'https://www.youtube.com/@LofiGirl/live' },
  { id: 'cafebgm', name: 'Cafe Music BGM', note: 'jazz & bossa café live', url: 'https://www.youtube.com/@CafeMusicBGMchannel/live' },
  { id: 'chillhop', name: 'Chillhop Radio', note: 'jazzy beats live', url: 'https://www.youtube.com/@ChillhopMusic/live' },
  { id: 'q-officejazz', name: 'Office jazz', note: 'search · instrumental', url: q('relaxing office jazz instrumental live') },
  { id: 'q-piano', name: 'Calm piano', note: 'search · instrumental', url: q('calm piano instrumental live') },
  { id: 'q-ambient', name: 'Coffee shop ambience', note: 'search · ambience', url: q('coffee shop ambience jazz live') },
];

// Keeps the chosen volume applied to any <video> YouTube creates later.
const KEEP_JS = "if(!window.__jvTimer){window.__jvTimer=setInterval(()=>{document.querySelectorAll('video').forEach(e=>{if(window.__jv!==undefined&&Math.abs(e.volume-window.__jv)>0.01)e.volume=window.__jv;})},1000)}";
// Search page: open the first real video result.
const FIRST_RESULT_JS = "(function(){let n=0;const t=setInterval(()=>{const a=[...document.querySelectorAll('a#video-title, a#video-title-link, ytd-video-renderer a#thumbnail')].find(x=>x.href&&x.href.includes('/watch'));if(a){clearInterval(t);location.href=a.href;}if(++n>40)clearInterval(t);},250);})();";

class YouTube extends EventEmitter {
  constructor(volume) {
    super();
    this.win = null;
    this.playing = false;
    this.title = '';
    this.volume = volume;
    this.ducked = false;
    this.autoplayFirst = false;
  }

  static get presets() { return PRESETS; }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyVolume(); }
  duck(on) { if (on === this.ducked) return; this.ducked = on; this.applyVolume(); }

  playPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    this.autoplayFirst = p.url.includes('/results?');
    this.title = p.name;
    this.load(p.url);
  }

  playQuery(query) {
    this.autoplayFirst = true;
    this.title = query;
    this.load(q(query));
  }

  stop() {
    if (this.win && !this.win.isDestroyed()) { this.win.webContents.loadURL('about:blank'); this.win.hide(); }
    this.playing = false;
    this.emit('change', false, this.title);
  }
  stopIfPlaying() { if (this.playing) this.stop(); }

  toggleWindow() {
    this.ensure();
    this.win.isVisible() ? this.win.hide() : this.win.showInactive();
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    this.win = new BrowserWindow({
      width: 520, height: 330, x: area.x + area.width - 540, y: area.y + area.height - 350,
      title: 'JARVIS · YouTube', alwaysOnTop: true, show: false, backgroundColor: '#000',
      webPreferences: { partition: 'persist:youtube', contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    // Plain Chrome user agent (YouTube serves a reduced site to unknown browsers).
    this.win.webContents.setUserAgent(this.win.webContents.getUserAgent().replace(/ (Electron|JARVIS)\/\S+/g, ''));
    this.win.on('close', (e) => { e.preventDefault(); this.win.hide(); });
    this.win.webContents.setWindowOpenHandler(({ url }) => { this.win.loadURL(url); return { action: 'deny' }; });
    const onPage = () => {
      const wc = this.win.webContents;
      wc.executeJavaScript(KEEP_JS).catch(() => {});
      this.applyVolume();
      if (this.autoplayFirst && wc.getURL().includes('/results')) {
        this.autoplayFirst = false;
        wc.executeJavaScript(FIRST_RESULT_JS).catch(() => {});
      }
    };
    this.win.webContents.on('did-finish-load', onPage);
    this.win.webContents.on('did-navigate-in-page', onPage);
  }

  load(url) {
    this.ensure();
    this.win.loadURL(url);
    this.win.showInactive();
    this.playing = true;
    log(`youtube: ${url}`);
    this.emit('change', true, this.title);
  }

  applyVolume() {
    if (!this.win || this.win.isDestroyed()) return;
    const v = this.ducked ? this.volume * 0.2 : this.volume;
    this.win.webContents.executeJavaScript(`window.__jv=${v};document.querySelectorAll('video').forEach(e=>{e.volume=${v}})`).catch(() => {});
  }

  destroy() { if (this.win && !this.win.isDestroyed()) { this.win.removeAllListeners('close'); this.win.destroy(); } }
}

module.exports = YouTube;
