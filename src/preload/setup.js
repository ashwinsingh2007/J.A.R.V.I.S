// Bridge for the setup / onboarding window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  get: () => ipcRenderer.invoke('setup:get'),
  save: (patch) => ipcRenderer.invoke('setup:save', patch),
  clearSecret: (key) => ipcRenderer.invoke('setup:clear-secret', key),
  test: (kind, key) => ipcRenderer.invoke('setup:test', { kind, key }),
  testVoice: (patch) => ipcRenderer.invoke('setup:test-voice', patch),
  installHooks: () => ipcRenderer.invoke('setup:install-hooks'),
  ollama: (action, opts = {}) => ipcRenderer.invoke('setup:ollama', { action, ...opts }),
  onOllamaProgress: (f) => ipcRenderer.on('ollama-progress', (e, p) => f(p)),
  open: (url) => ipcRenderer.invoke('setup:open', url),
  finish: () => ipcRenderer.invoke('setup:finish'),
  onTheme: (f) => ipcRenderer.on('theme', (e, t) => f(t)),
});
