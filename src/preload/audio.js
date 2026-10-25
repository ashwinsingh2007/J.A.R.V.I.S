// Bridge for the hidden audio window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  on: (cb) => ipcRenderer.on('audio', (_e, msg) => cb(msg)),
  send: (type, v) => ipcRenderer.send('audio', { type, v }),
});
