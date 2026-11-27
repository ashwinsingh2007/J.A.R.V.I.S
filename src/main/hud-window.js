// The face: the HUD page (Three.js reactor). Main pushes events in with
// window.hud.event(...); the page posts messages back through the
// webkit.messageHandlers.jarvis shim in preload/hud.js.
//
// events: 'text' (typed command), 'action' (name, body), 'visible' (on: shown, not minimised and focused)
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { BrowserWindow, ipcMain, screen } = require('electron');
const C = require('./config');
const { log } = require('./util');

const BOUNDS_FILE = path.join(C.STATE_DIR, 'window.json');

// Desktop mode's blur, 0 to 100, as macOS frosted glass. macOS blurs what is behind a window at one
// fixed strength and has no setting for it, so the steps are materials from the most see-through
// frost to an almost solid one: what changes is how much of the glass's own fill covers the blur.
const FROST = [null, 'fullscreen-ui', 'popover', 'under-window', 'sheet'];
const frostOf = (blur) => FROST[Math.round(Math.min(100, Math.max(0, Number(blur) || 0)) / 25)];

class HudWindow extends EventEmitter {
  /**
   * hidden: started from the terminal; the page loads, but the window waits for show().
   * desktop: { opacity, blur, behind } for desktop mode (no frame, a transparent background), else null.
   * Frame and transparency can only be set when a window is made, so switching the mode takes a restart.
   */
  constructor(theme = {}, { hidden = false, desktop = null } = {}) {
    super();
    this.ready = false;
    this.backlog = [];
    this.quitting = false;
    this.desktop = !!desktop;
    this.behind = false;
    let bounds = { width: 1440, height: 900 };
    try {
      const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
      // Only reuse saved bounds when they are still on a connected display.
      if (screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.x < d.bounds.x + d.bounds.width && b.y >= d.bounds.y - 50 && b.y < d.bounds.y + d.bounds.height)) bounds = b;
    } catch {}
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: 1000, minHeight: 650,
      title: 'J.A.R.V.I.S',
      backgroundColor: theme.background || '#03050d',
      // Desktop mode: no title bar, traffic lights or shadow, and the page draws its own background at
      // the chosen opacity. The frost stays on when the HUD isn't the focused window (macOS would
      // otherwise turn it flat grey), as it usually isn't on the desktop.
      ...(desktop ? { frame: false, transparent: true, hasShadow: false, backgroundColor: '#00000000', visualEffectState: 'active', vibrancy: frostOf(desktop.blur) || undefined } : {}),
      show: false,
      // Throttled in the background (the default), so a hidden, minimised or covered HUD reports
      // document.hidden and stops drawing. Nothing that must keep running lives here: JARVIS's voice
      // and the music play in the audio window, and every timer that matters runs in main.
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'hud.js'), contextIsolation: true, sandbox: true, backgroundThrottling: true },
    });
    const query = { theme: theme.theme || 'jarvis', mode: theme.mode || 'dark' };
    if (desktop) Object.assign(query, { desk: '1', opacity: String(desktop.opacity) });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'hud', 'index.html'), { query });
    if (!hidden) this.win.once('ready-to-show', () => this.win.show());
    this.win.webContents.on('did-start-loading', () => { this.ready = false; });
    // Links in the HUD open in the browser, never inside the app.
    this.win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) require('electron').shell.openExternal(url); return { action: 'deny' }; });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    const saveBounds = () => { if (!this.win.isFullScreen()) try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(this.win.getBounds())); } catch {} };
    this.win.on('resized', saveBounds);
    this.win.on('moved', saveBounds);
    // Closing the window keeps JARVIS running in the menu bar.
    this.win.on('close', (e) => { if (!this.quitting) { e.preventDefault(); this.win.hide(); } });
    // Whether the user is looking at the HUD, so what only feeds it can slow down while they aren't,
    // and the page itself stops drawing (in the background a window often still shows, partly covered).
    let was = null;
    const changed = this.changed = () => setImmediate(() => {
      const on = this.visible;
      if (on === was) return;
      was = on;
      log(`hud: ${on ? 'awake' : 'asleep (in the background, minimised or hidden)'}`);
      this.send('window', { awake: on });
      this.emit('visible', on);
    });
    for (const ev of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) this.win.on(ev, changed);
    if (desktop) this.setDesktop(desktop);

    ipcMain.on('hud', (e, msg) => {
      if (e.sender !== this.win.webContents || !msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        this.ready = true;
        for (const js of this.backlog) this.exec(js);
        this.backlog = [];
        this.send('window', { awake: this.visible });
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

  /** Whether the user is looking at the HUD: shown, not minimised, and the focused window. Behind other
   *  windows on the desktop it is seen without focus, so focus doesn't count there (a window that is
   *  fully covered still stops drawing on its own). JARVIS_TEST_AWAKE ignores focus, for tests driving a
   *  window in the background. */
  get visible() {
    return !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized() && (this.win.isFocused() || this.behind || !!process.env.JARVIS_TEST_AWAKE);
  }

  /**
   * Desktop mode's settings that apply at once: the frost, and staying behind other windows. Behind is
   * one level under normal windows, so it sits above the wallpaper and desktop icons, every other
   * window covers it, and it can still be clicked, typed in and dragged. The opacity is the page's.
   */
  setDesktop({ blur, behind }) {
    if (!this.desktop || this.win.isDestroyed()) return;
    this.win.setVibrancy(frostOf(blur), { animationDuration: 150 });
    this.win.setBackgroundColor('#00000000');
    this.behind = !!behind;
    if (this.behind) this.win.setAlwaysOnTop(true, 'normal', -1);
    else this.win.setAlwaysOnTop(false);
    log(`hud: desktop mode, frost ${frostOf(blur) || 'off'}, ${this.behind ? 'behind other windows' : 'a normal window level'}`);
    this.changed();
  }

  show() { if (this.win.isMinimized()) this.win.restore(); this.win.show(); this.win.focus(); }
  toggleFullScreen() { this.show(); this.win.setFullScreen(!this.win.isFullScreen()); }
  destroy() { this.quitting = true; if (!this.win.isDestroyed()) this.win.destroy(); }
}

HudWindow.frostOf = frostOf;
module.exports = HudWindow;
