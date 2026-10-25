// JARVIS — Electron entry point. Menu bar item, HUD window, setup window,
// and the orchestrator that runs everything else.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, ipcMain, shell, safeStorage, Notification } = require('electron');
const C = require('./config');
const { log, initPaths, paths, run, which } = require('./util');

app.setName('JARVIS');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Test hooks: JARVIS_STATE_DIR isolates config + Electron profile (so a test
// instance can run next to the real one), JARVIS_TEST_MUTE silences all audio,
// JARVIS_EARS_BIN swaps the microphone sidecar for a scripted fake.
if (process.env.JARVIS_STATE_DIR) app.setPath('userData', path.join(C.STATE_DIR, 'electron'));
if (process.env.JARVIS_TEST_MUTE) app.commandLine.appendSwitch('mute-audio');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let cfg, hud, orch, audio, tray, telegram, setupWin = null, found = null, testAudio = null;
const flags = new Set(process.argv.slice(1));

function sidecarPath() {
  if (process.env.JARVIS_EARS_BIN) return process.env.JARVIS_EARS_BIN;
  const candidates = [path.join(process.resourcesPath || '', 'jarvis-ears'), path.join(paths.root, 'resources', 'jarvis-ears')];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}

app.on('second-instance', () => { if (hud) hud.show(); else if (setupWin) setupWin.show(); });

app.whenReady().then(async () => {
  C.attachSafeStorage(safeStorage);
  try { fs.writeFileSync(C.LOG_FILE, ''); } catch {}
  // Scripts and prompts: bundled in Resources when packaged, else the repo root.
  initPaths(fs.existsSync(path.join(process.resourcesPath || '', 'scripts', 'sessions.sh')) ? process.resourcesPath : path.join(__dirname, '..', '..'));
  cfg = C.load();
  nativeTheme.themeSource = cfg.themeMode;
  log(`jarvis: starting, root ${paths.root}`);
  appMenu();

  const brains = require('./brain');
  found = await brains.detect(cfg);
  if (!cfg.onboarded || flags.has('--setup')) { openSetup(true); return; }
  startJarvis(brains);
});

function startJarvis(brains) {
  const AudioHost = require('./audio-host');
  const HudWindow = require('./hud-window');
  const { Ears, vocabulary } = require('./ears');
  const { Orchestrator } = require('./orchestrator');

  audio = testAudio || new AudioHost();
  hud = new HudWindow(themeOf(cfg));
  const brain = brains.create(cfg, found);
  const ears = new Ears(cfg, sidecarPath(), vocabulary(cfg));
  orch = new Orchestrator({ cfg, brain, ears, audio, hud, found });
  hud.send('info', { claude: found.claude.version || 'not installed', model: brain.label, voice: cfg.ttsEngine });

  buildTray();
  orch.on('state', updateTrayTitle);
  orch.on('disabled', buildTray);
  orch.on('open-setup', () => openSetup(false));
  orch.on('set-theme', (t) => saveTheme(t));
  orch.on('settings', (patch) => saveHudSettings(patch));
  orch.on('hands-permit', permitHands);
  orch.on('notify', (title, body) => { try { new Notification({ title, body }).show(); } catch {} });
  orch.on('telegram-push', (text) => { if (telegram && cfg.telegramChatId) telegram.send(cfg.telegramChatId, text); });
  sendHudSettings();
  checkHands().then(sendHudSettings);
  ears.on('devices', buildTray);

  if (cfg.telegramToken) {
    const Telegram = require('./telegram');
    telegram = new Telegram(cfg, orch);
    telegram.on('status', (s) => { orch.telegramStatus = s; hud.send('notice', { text: `Telegram: ${s}` }); buildTray(); });
    telegram.start();
  }
  orch.start(!flags.has('--no-voice'));
}

/** Theme for new windows; "system" resolved now (the page keeps following macOS). */
function themeOf(c) {
  const light = c.themeMode === 'light' || (c.themeMode === 'system' && !nativeTheme.shouldUseDarkColors);
  return { theme: c.theme, mode: c.themeMode, background: light ? '#f4f5f7' : '#03050d' };
}

// ---------- menu bar ----------

const GLYPH = { idle: '◉', listening: '◎', thinking: '◐', speaking: '◍', muted: '○', error: '⊗', booting: '◌' };
function updateTrayTitle(s) { if (tray) tray.setTitle(GLYPH[s] || '◉'); }

function buildTray() {
  if (!tray) { tray = new Tray(nativeImage.createEmpty()); tray.setToolTip('JARVIS'); updateTrayTitle('booting'); }
  const devices = (orch && orch.ears.devices) || [];
  const menu = Menu.buildFromTemplate([
    { label: 'Show HUD', accelerator: 'Cmd+J', click: () => hud.show() },
    { label: 'Toggle Full Screen', accelerator: 'Cmd+F', click: () => hud.toggleFullScreen() },
    { type: 'separator' },
    { label: orch && orch.disabled ? 'Enable JARVIS' : 'Disable JARVIS', accelerator: 'Cmd+D', click: () => orch.toggleDisabled() },
    { label: 'Standby (mic off) / Resume', accelerator: 'Cmd+M', click: () => orch.toggleMute() },
    { label: 'Stop Talking', accelerator: 'Cmd+.', click: () => orch.interrupt() },
    { label: 'New Conversation', accelerator: 'Cmd+N', click: () => orch.newConversation() },
    { type: 'separator' },
    {
      label: 'Input Device',
      submenu: devices.length
        ? devices.map((d) => ({ label: d.name, type: 'radio', checked: !!d.default, click: () => { orch.ears.setInput(d.id); orch.notice(`Listening on ${d.name}.`); } }))
        : [{ label: 'No input devices', enabled: false }],
    },
    { label: `Brain: ${orch ? orch.brain.label : '—'}`, enabled: false },
    { label: `Telegram: ${cfg.telegramToken ? (telegram ? telegram.status : 'connecting…') : 'not configured'}`, enabled: false },
    { type: 'separator' },
    { label: 'Setup…', click: () => openSetup(false) },
    { label: 'Open Log', click: () => shell.openPath(C.LOG_FILE) },
    { label: 'Quit JARVIS', accelerator: 'Cmd+Q', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [{ role: 'about' }, { label: 'Setup…', click: () => openSetup(false) }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

app.on('activate', () => { if (hud) hud.show(); else if (setupWin) setupWin.show(); });
app.on('window-all-closed', () => { if (!hud) app.quit(); });
app.on('before-quit', () => {
  if (orch) orch.shutdown();
  if (telegram) telegram.stop();
  if (hud) hud.destroy();
});

// ---------- setup / onboarding ----------

function openSetup(firstRun) {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); return; }
  const c = C.load();
  const t = themeOf(c);
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  setupWin = new BrowserWindow({
    width: Math.min(1180, workArea.width - 80), height: Math.min(880, workArea.height - 60),
    minWidth: 980, minHeight: 720, center: true, title: firstRun ? 'Welcome to JARVIS' : 'JARVIS Setup',
    backgroundColor: t.background,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'setup.js'), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup', 'setup.html'), { query: { first: firstRun ? '1' : '0', theme: c.theme, mode: c.themeMode } });
  setupWin.on('page-title-updated', (e) => e.preventDefault());
  setupWin.on('closed', () => { setupWin = null; if (!hud) app.quit(); });   // setup closed before JARVIS started
}

const fromSetup = (e) => setupWin && e.sender === setupWin.webContents;

function hooksInstalled() {
  try { return fs.readFileSync(path.join(C.HOME, '.claude', 'settings.json'), 'utf8').includes('hook-event.sh'); } catch { return false; }
}

ipcMain.handle('setup:get', async (e) => {
  if (!fromSetup(e)) return null;
  const current = C.load();
  found = await require('./brain').detect(current);
  const safe = { ...current };
  for (const k of C.SECRET_KEYS) { safe[k] = ''; safe[`has_${k}`] = !!current[k]; }
  const sayVoices = await macVoices();
  return {
    cfg: safe,
    found,
    installed: {
      kokoro: fs.existsSync(paths.python) && fs.existsSync(path.join(paths.models, 'kokoro-v1.0.onnx')),
      edge: fs.existsSync(paths.edgeTTS),
      ffmpeg: !!which('ffmpeg'),
      iterm: fs.existsSync('/Applications/iTerm.app'),
      ears: fs.existsSync(sidecarPath()),
      hooks: hooksInstalled(),
    },
    sayVoices,
    running: !!orch,
  };
});

ipcMain.handle('setup:save', (e, patch) => {
  if (!fromSetup(e) || !patch || typeof patch !== 'object') return false;
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in C.DEFAULTS)) continue;
    if (C.SECRET_KEYS.has(k) && v === '') continue;     // empty secret field = keep the stored one
    clean[k] = v;
  }
  // Clamp junk (negative seconds, letters in number fields…) before it is stored.
  const fixed = C.sanitize({ ...C.DEFAULTS, ...clean });
  for (const k of Object.keys(clean)) if (!C.SECRET_KEYS.has(k)) clean[k] = fixed[k];
  C.save(clean);
  if ('theme' in clean || 'themeMode' in clean) broadcastTheme();
  return true;
});

// Settings the HUD can change live. Keys, Telegram and the brain provider stay in Setup.
const HUD_KEYS = ['ttsEngine', 'kokoroVoice', 'kokoroSpeed', 'edgeVoice', 'nativeVoice', 'elevenLabsModel',
  'sttEngine', 'appleSpeech', 'speechLocale', 'commandSilenceSeconds', 'requireEndWord',
  'model', 'effort', 'agentModel', 'progressUpdates', 'screenControl', 'morningBriefing', 'checkIns', 'honorific', 'announceSessions', 'autoHide'];

/** Accessibility and Screen Recording for JARVIS.app, as the screen-control helper sees them. */
let handsState = null;
async function checkHands(prompt = false) {
  const bin = path.join(paths.root, 'resources', 'jarvis-hands');
  if (!fs.existsSync(bin)) { handsState = { missing: true }; return handsState; }
  const r = await run(bin, prompt ? ['check', '--prompt'] : ['check'], { timeout: 10000 });
  handsState = { ax: /accessibility: yes/.test(r.out), screen: /screen recording: yes/.test(r.out) };
  log(`hands: accessibility=${handsState.ax} screen=${handsState.screen}`);
  return handsState;
}

/** HUD button: show the macOS permission dialogs and settings panes, then report back. */
async function permitHands() {
  const s = await checkHands(true);
  if (!s.ax) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  else if (!s.screen) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  for (const ms of [4000, 15000, 40000]) setTimeout(() => checkHands().then(sendHudSettings), ms);
}

/** English macOS voices, minus the novelty ones. */
async function macVoices() {
  const r = await run('/usr/bin/say', ['-v', '?'], { timeout: 5000 });
  // "Daniel (English (UK))  en_GB  # Hello…"
  const NOVELTY = new Set(['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred', 'Kathy']);
  return [...new Set(r.out.split('\n').map((l) => /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(l)).filter(Boolean)
    .filter((m) => m[2].startsWith('en_')).map((m) => m[1].trim()).filter((n) => !NOVELTY.has(n)))];
}

/** Current values back to the HUD. The macOS voice list is looked up once and sent once. */
let hudVoicesSent = false;
function sendHudSettings() {
  if (!hud) return;
  const values = {};
  for (const k of HUD_KEYS) values[k] = cfg[k];
  if (!hudVoicesSent) {
    hudVoicesSent = true;
    macVoices().then((sayVoices) => { if (hud) hud.send('settings', { sayVoices, values: { nativeVoice: cfg.nativeVoice } }); });
  }
  hud.send('settings', {
    values,
    autoHideMs: Number(process.env.JARVIS_TEST_AUTOHIDE_MS) || 0,
    hands: handsState,
    brain: orch ? orch.brain.label : '',
    available: {
      kokoro: fs.existsSync(paths.python) && fs.existsSync(path.join(paths.models, 'kokoro-v1.0.onnx')),
      edge: fs.existsSync(paths.edgeTTS),
      elevenlabs: !!cfg.elevenLabsApiKey,
    },
  });
}

/** A change from the HUD: clamp it, store it, put it into the live config and apply it. */
function saveHudSettings(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (HUD_KEYS.includes(k)) clean[k] = v;
  if (!Object.keys(clean).length) return;
  const fixed = C.sanitize({ ...C.load(), ...clean });
  const changed = Object.keys(clean).filter((k) => JSON.stringify(fixed[k]) !== JSON.stringify(cfg[k]));
  const save = {};
  for (const k of Object.keys(clean)) save[k] = fixed[k];
  C.save(save);
  Object.assign(cfg, save);
  if (changed.length && orch) orch.applySettings(changed);
  sendHudSettings();
}

/** Theme picked in the HUD: store it (junk falls back to defaults) and apply everywhere. */
function saveTheme({ theme, themeMode }) {
  const patch = {};
  if (theme) patch.theme = theme;
  if (themeMode) patch.themeMode = themeMode;
  if (!Object.keys(patch).length) return;
  const fixed = C.sanitize({ ...C.load(), ...patch });
  C.save({ theme: fixed.theme, themeMode: fixed.themeMode });
  broadcastTheme();
}

/** Theme changes apply live to every open window. */
function broadcastTheme() {
  const c = C.load();
  nativeTheme.themeSource = c.themeMode;
  if (hud) hud.send('theme', { theme: c.theme, mode: c.themeMode });
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('theme', { theme: c.theme, mode: c.themeMode });
}

ipcMain.handle('setup:clear-secret', (e, key) => { if (fromSetup(e) && C.SECRET_KEYS.has(key)) C.save({ [key]: '' }); return true; });

ipcMain.handle('setup:test', async (e, { kind, key }) => {
  if (!fromSetup(e)) return { ok: false };
  const stored = C.load();
  try {
    if (kind === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=50', { headers: { 'x-api-key': key || stored.anthropicApiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
      return { ok: true, models: ((await r.json()).data || []).map((m) => m.id) };
    }
    if (kind === 'gemini') {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', { headers: { authorization: `Bearer ${key || stored.geminiApiKey}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
      const ids = ((await r.json()).data || []).map((m) => String(m.id).replace(/^models\//, ''));
      return { ok: true, models: ids.filter((id) => /^gemini/.test(id) && !/embedding|image|tts|audio|live/.test(id)) };
    }
    if (kind === 'elevenlabs') {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key || stored.elevenLabsApiKey }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
      return { ok: true, voices: ((await r.json()).voices || []).map((v) => ({ id: v.voice_id, name: v.name })) };
    }
    if (kind === 'ollama') {
      const r = await fetch(`${(key || stored.ollamaUrl).replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) });
      return { ok: r.ok, models: r.ok ? ((await r.json()).models || []).map((m) => m.name) : [] };
    }
    if (kind === 'telegram') {
      const r = await fetch(`https://api.telegram.org/bot${key || stored.telegramToken}/getMe`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      return { ok: !!j.ok, msg: j.ok ? `@${j.result.username}` : j.description };
    }
  } catch (err) { return { ok: false, msg: err.message }; }
  return { ok: false };
});

ipcMain.handle('setup:test-voice', async (e, patch) => {
  if (!fromSetup(e)) return false;
  const Speaker = require('./speaker');
  if (!testAudio) testAudio = audio || new (require('./audio-host'))();
  const merged = { ...C.load(), ...Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => !(C.SECRET_KEYS.has(k) && v === ''))) };
  const sp = new Speaker(merged, testAudio);
  sp.on('finish', () => setTimeout(() => sp.shutdown(), 500));
  setTimeout(() => sp.speak(`Good evening, ${merged.honorific || 'sir'}. This is how I sound.`), sp.engine === 'kokoro' ? 2500 : 0);
  return sp.engine;
});

ipcMain.handle('setup:install-hooks', async (e) => {
  if (!fromSetup(e)) return { ok: false };
  const r = await run('/bin/sh', [path.join(paths.scripts, 'install-hooks.sh')], { timeout: 20000 });
  return { ok: r.code === 0, msg: (r.out + r.err).trim().slice(0, 300) };
});

ipcMain.handle('setup:open', (e, url) => { if (fromSetup(e) && /^(https:\/\/|x-apple\.systempreferences:)/.test(url)) shell.openExternal(url); });

ipcMain.handle('setup:finish', async (e) => {
  if (!fromSetup(e)) return;
  C.save({ onboarded: true });
  if (!orch) {
    // First run: start JARVIS in this process with the new settings.
    log('setup: finished, starting');
    cfg = C.load();
    const brains = require('./brain');
    found = await brains.detect(cfg);
    startJarvis(brains);
    if (setupWin) setupWin.close();
    return;
  }
  log('setup: finished, relaunching');
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--setup') });
  app.exit(0);
});
