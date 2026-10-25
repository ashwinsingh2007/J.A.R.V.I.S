// The face: the HUD page (Three.js reactor). Main pushes events in with
// window.hud.event(...); the page posts messages back through the
// webkit.messageHandlers.jarvis shim in preload/hud.js.
//
// events: 'text' (typed command), 'action' (name, body)
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { BrowserWindow, ipcMain, screen } = require('electron');
const C = require('./config');

const BOUNDS_FILE = path.join(C.STATE_DIR, 'window.json');

class HudWindow extends EventEmitter {
  constructor(theme = {}) {
    super();
    this.ready = false;
    this.backlog = [];
    this.quitting = false;
    let bounds = { width: 1440, height: 900 };
    try {
      const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
      // Only reuse saved bounds when they are still on a connected display.
      if (screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.x < d.bounds.x + d.bounds.width && b.y >= d.bounds.y - 50 && b.y < d.bounds.y + d.bounds.height)) bounds = b;
    } catch {}
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: 1000, minHeight: 650,
      title: 'J.A.R.V.I.S.',
      backgroundColor: theme.background || '#03050d',
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'hud.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'index.html'), { query: { theme: theme.theme || 'jarvis', mode: theme.mode || 'dark' } });
    this.win.once('ready-to-show', () => this.win.show());
    this.win.webContents.on('did-start-loading', () => { this.ready = false; });
    // Links in the HUD open in the browser, never inside the app.
    this.win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) require('electron').shell.openExternal(url); return { action: 'deny' }; });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    const saveBounds = () => { if (!this.win.isFullScreen()) try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(this.win.getBounds())); } catch {} };
    this.win.on('resized', saveBounds);
    this.win.on('moved', saveBounds);
    // Closing the window keeps JARVIS running in the menu bar.
    this.win.on('close', (e) => { if (!this.quitting) { e.preventDefault(); this.win.hide(); } });

    ipcMain.on('hud', (e, msg) => {
      if (e.sender !== this.win.webContents || !msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        this.ready = true;
        for (const js of this.backlog) this.exec(js);
        this.backlog = [];
      } else if (msg.type === 'text' && msg.text) {
        this.emit('text', String(msg.text));
      } else if (msg.type === 'action' && msg.name) {
        this.emit('action', String(msg.name), msg);
      }
    });
  }

  exec(js) { if (!this.win.isDestroyed()) this.win.webContents.executeJavaScript(js).catch(() => {}); }

  push(js) {
    if (this.ready) this.exec(js);
    else { this.backlog.push(js); if (this.backlog.length > 400) this.backlog.shift(); }
  }

  send(type, payload = {}) { this.push(`window.hud && window.hud.event(${JSON.stringify({ ...payload, type })});`); }
  sendRaw(type, data) { this.push(`window.hud && window.hud.event(${JSON.stringify({ type, data })});`); }

  show() { if (this.win.isMinimized()) this.win.restore(); this.win.show(); this.win.focus(); }
  toggleFullScreen() { this.show(); this.win.setFullScreen(!this.win.isFullScreen()); }
  destroy() { this.quitting = true; if (!this.win.isDestroyed()) this.win.destroy(); }
}

module.exports = HudWindow;
