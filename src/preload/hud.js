// The HUD was written for WKWebView: it posts to
// window.webkit.messageHandlers.jarvis. Provide the same shape here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    jarvis: { postMessage: (msg) => ipcRenderer.send('hud', msg) },
  },
});
