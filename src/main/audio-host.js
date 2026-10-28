// Hidden window that plays JARVIS's voice (Web Audio, with a level meter for
// the HUD) and the background music (<audio>). Kept separate from the HUD so
// closing or reloading the HUD never cuts the sound.
//
// events: 'tts-ended', 'tts-level' (v), 'music-playing', 'music-error' (msg), 'music-ended'
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { BrowserWindow, ipcMain } = require('electron');
const { log } = require('./util');

class AudioHost extends EventEmitter {
  constructor() {
    super();
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'audio.js'),
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'audio', 'audio.html'));
    ipcMain.on('audio', (e, msg) => {
      if (e.sender !== this.win.webContents) return;
      if (msg.type === 'log') log(`audio: ${msg.msg}`);
      else this.emit(msg.type, msg.v);
    });
  }

  send(msg) { if (!this.win.isDestroyed()) this.win.webContents.send('audio', msg); }

  /** volume: the voice's volume, 0 to 1. */
  playTTS(file, volume = 1) {
    let data;
    try { data = fs.readFileSync(file); } catch (e) { log(`audio: cannot read ${file}`); setTimeout(() => this.emit('tts-ended'), 0); return; }
    fs.rm(file, () => {});
    this.send({ type: 'tts-play', data, volume });
  }
  stopTTS() { this.send({ type: 'tts-stop' }); }
  setTTSVolume(v) { this.send({ type: 'tts-volume', v }); }

  playMusic(url, volume) { this.send({ type: 'music-play', url, volume }); }
  stopMusic() { this.send({ type: 'music-stop' }); }
  setMusicVolume(v) { this.send({ type: 'music-volume', v }); }
  chime() { this.send({ type: 'chime' }); }
}

module.exports = AudioHost;
