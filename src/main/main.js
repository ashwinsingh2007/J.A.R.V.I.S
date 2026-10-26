// JARVIS — Electron entry point. Menu bar item, HUD window, setup window,
// and the orchestrator that runs everything else.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, ipcMain, shell, safeStorage, Notification } = require('electron');
const C = require('./config');
const { ASSISTANTS, SCOPED, assistantOf, allAssistants, findByName, newId, exists } = require('./assistants');
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

function sidecarPath(real = false) {
  if (process.env.JARVIS_EARS_BIN && !real) return process.env.JARVIS_EARS_BIN;
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
  if (brain.fallback) hud.send('notice', { text: `${assistantOf(cfg.assistant, cfg).name} needs ${brain.fallback}, so it is thinking with ${brain.label} for now.` });

  buildTray();
  orch.on('state', updateTrayTitle);
  orch.on('disabled', buildTray);
  orch.on('open-setup', (section) => openSettings(section));
  hud.on('action', (name, msg) => { if (name.startsWith('cfg:')) hudSettingsAction(name, msg); else if (name.startsWith('ext:')) extensionsAction(name, msg); });
  orch.on('set-theme', (t) => saveTheme(t));
  orch.on('settings', (patch) => saveHudSettings(patch));
  orch.on('hands-permit', permitHands);
  orch.on('notify', (title, body) => { try { new Notification({ title, body }).show(); } catch {} });
  orch.on('telegram-push', (text) => { if (telegram && cfg.telegramChatId) telegram.send(cfg.telegramChatId, text); });
  orch.on('switch-assistant', switchAssistant);
  orch.on('reset-assistant', resetAssistant);
  orch.on('assistant-edit', editAssistant);
  orch.on('refresh-assistant', () => refreshCurrent('The change'));
  sendHudSettings();
  sendAssistants();
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
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Open Log', click: () => shell.openPath(C.LOG_FILE) },
    { label: 'Quit JARVIS', accelerator: 'Cmd+Q', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [{ role: 'about' }, { label: 'Settings…', click: () => openSettings() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
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

/** Setup on first run; afterwards the same screens are the Settings window, opened at a section. */
function openSetup(firstRun, section = '') {
  if (setupWin && !setupWin.isDestroyed()) { if (section) setupWin.webContents.send('goto', section); setupWin.show(); setupWin.focus(); return; }
  const c = C.load();
  const t = themeOf(c);
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  setupWin = new BrowserWindow({
    width: Math.min(1180, workArea.width - 80), height: Math.min(880, workArea.height - 60),
    minWidth: 980, minHeight: 720, center: true, title: firstRun ? 'Welcome to JARVIS' : 'JARVIS Settings',
    backgroundColor: t.background,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'setup.js'), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup', 'setup.html'), { query: { first: firstRun ? '1' : '0', section: String(section || ''), theme: c.theme, mode: c.themeMode } });
  setupWin.on('page-title-updated', (e) => e.preventDefault());
  setupWin.on('closed', () => { setupWin = null; if (!hud) app.quit(); });   // setup closed before JARVIS started
}

/** Settings while JARVIS runs: the HUD's Settings tab, opened at a section. Setup is only the first run. */
function openSettings(section = '') {
  if (!hud) return openSetup(false, section);
  hud.show();
  hud.send('open-settings', { section: String(section || '') });
}

const setupContents = () => (setupWin && !setupWin.isDestroyed() ? setupWin.webContents : null);
const fromSetup = (e) => !!setupContents() && e.sender === setupContents();

function hooksInstalled() {
  try { return fs.readFileSync(path.join(C.HOME, '.claude', 'settings.json'), 'utf8').includes('hook-event.sh'); } catch { return false; }
}

/** What Setup and Settings show: the config with secrets replaced by has_ flags, and what this Mac has. */
async function setupInfo() {
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
    brain: orch ? orch.brain.label : '',
    workerAvailable: !!(orch && orch.brain.worker) || !!(found && found.claude.path && found.claude.loggedIn),
  };
}
ipcMain.handle('setup:get', (e) => (fromSetup(e) ? setupInfo() : null));

/** Store a patch from Setup or Settings: known keys only, junk clamped, an empty secret keeps the stored one. */
function setupSave(patch) {
  if (!patch || typeof patch !== 'object') return false;
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
}
ipcMain.handle('setup:save', (e, patch) => (fromSetup(e) ? setupSave(patch) : false));

// Settings the HUD can change live. Keys, Telegram and the brain provider stay in Setup.
const HUD_KEYS = ['ttsEngine', 'kokoroVoice', 'kokoroSpeed', 'edgeVoice', 'nativeVoice', 'elevenLabsModel',
  'sttEngine', 'appleSpeech', 'speechLocale', 'commandSilenceSeconds', 'requireEndWord',
  'model', 'effort', 'agentModel', 'progressUpdates', 'screenControl', 'morningBriefing', 'checkIns', 'honorific', 'announceSessions', 'autoHide', 'worker', 'greetOnStart'];

/** The assistants for the HUD: who is in use, and what each one is, with the user's changes. */
function sendAssistants(extra = {}) {
  if (!hud) return;
  const mine = cfg.assistantSettings || {};
  const base = Object.fromEntries(SCOPED.filter((k) => k !== 'wakeWords').map((k) => [k, C.DEFAULTS[k]]));
  const f = found || {};
  hud.send('assistants', {
    id: cfg.assistant,
    ...extra,
    // What the Agents tab needs to say which brains are set up here.
    env: {
      ready: { 'claude-code': !!(f.claude && f.claude.path && f.claude.loggedIn), anthropic: !!cfg.anthropicApiKey, gemini: !!cfg.geminiApiKey, ollama: !!(f.ollama && f.ollama.running) },
      ollamaModels: (f.ollama && f.ollama.models) || [],
      engine: cfg.ttsEngine,
    },
    list: allAssistants(cfg).map((a) => {
      const own = mine[a.id] || {};
      return {
        id: a.id, name: a.name, tier: a.tier, about: a.about, needs: a.needs, custom: a.custom, persona: a.persona,
        defaultPersona: (ASSISTANTS[a.id] || (cfg.customAssistants || {})[a.id] || {}).persona || '',
        wakeWords: own.wakeWords || a.settings.wakeWords || [], changed: Object.keys(own).length > 0,
        skills: Array.isArray(own.skills) ? own.skills : null, mcp: Array.isArray(own.mcp) ? own.mcp : null,
        // Its brain, model, worker and voice as they stand: defaults, then its preset, then the user's changes.
        settings: a.id === cfg.assistant ? Object.fromEntries(Object.keys(base).map((k) => [k, cfg[k]]))
          : { ...base, ...Object.fromEntries(Object.entries(a.settings || {}).filter(([k]) => k in base)), ...Object.fromEntries(Object.entries(own).filter(([k]) => k in base)) },
      };
    }),
  });
}

/** Another assistant takes over: its preset with the user's changes to it, and a fresh brain from the shared conversation. */
async function switchAssistant(id, { quiet = false } = {}) {
  if (!orch || !exists(id, cfg)) return;
  // Another assistant whose brain can't run here stays put, and says what it needs. (Looked up again
  // first, in case Ollama was started or a key added since.) The one in use, refreshed after a change,
  // falls back to the best brain instead.
  if (id !== cfg.assistant) {
    const brains = require('./brain');
    const next = C.load(id);
    let why = brains.unavailable(next, found);
    if (why) { found = await brains.detect(next); why = brains.unavailable(next, found); }
    if (why) {
      const name = assistantOf(id, cfg).name;
      log(`assistant: ${name} needs ${why}; staying with ${orch.name}`);
      orch.speaker.speak(`${name} needs ${why}, ${cfg.honorific}. Set that up in Settings, under Brains and keys, first.`);
      hud.send('notice', { text: `${name} needs ${why}. Set it up in Settings › Brains & keys.` });
      hud.send('assistant', { id: cfg.assistant, name: orch.name });
      sendAssistants();
      return;
    }
  }
  C.save({ assistant: id });
  Object.assign(cfg, C.load());
  const brain = require('./brain').create(cfg, found, { fresh: true });
  orch.switchBrain(brain, { quiet });
  if (brain.fallback) hud.send('notice', { text: `${assistantOf(id, cfg).name} needs ${brain.fallback}, so it is thinking with ${brain.label} for now.` });
  sendHudSettings();
  sendAssistants();
  buildTray();
}

/** The assistant in use changed (persona, wake words, a reset): start its brain again, or say when it will. */
function refreshCurrent(what) {
  Object.assign(cfg, C.load());
  sendHudSettings();
  sendAssistants();
  const wait = orch && orch.canSwitch();
  if (!orch) return;
  if (wait) {
    hud.send('notice', { text: `Saved. ${what} applies once ${wait}.` });
    // A running job: wait for it (orchestrator). Only an answer in progress: try again shortly.
    if (orch.progress.size) orch.refreshLater = true; else setTimeout(() => refreshCurrent(what), 5000);
    return;
  }
  if (orch.brain.context) orch.brain.context.handover();
  switchAssistant(cfg.assistant, { quiet: true });
}

/** Back to the preset: forget the user's changes to one assistant. The one in use starts again with it. */
function resetAssistant(id) {
  C.resetAssistant(id);
  log(`assistant: ${assistantOf(id, cfg).name} back to its preset`);
  if (id === cfg.assistant) refreshCurrent('The preset'); else { cfg.assistantSettings = C.load().assistantSettings; sendAssistants(); }
}

/**
 * Settings: the skills and MCP servers on this Mac, and getting more. Anything that installs or removes
 * comes from a click the user confirmed in the HUD. A new or removed skill reaches the assistant in use
 * when its brain starts again, so that happens straight away (quietly).
 */
let mcpChecking = null;
async function extensionsAction(name, msg = {}) {
  const skills = require('./skills');
  const mcp = require('./mcp');
  const reply = (extra = {}) => hud && hud.send('ext', { skills: skills.catalog().map(({ path: _p, ...s }) => s), mcp: mcp.list(), markets: skills.marketplaces(), ...extra });
  const done = (error, what) => { reply({ error: error || '', done: error ? '' : what }); if (!error) refreshCurrent('It'); };
  try {
    if (name === 'ext:list') {
      reply();
      if (!mcpChecking) mcpChecking = mcp.check().finally(() => { mcpChecking = null; });
      await mcpChecking;
      reply();
    } else if (name === 'ext:check') { await mcp.check(); reply(); }
    else if (name === 'ext:install') done(await skills.install(msg.plugin, msg.market), `Installed ${msg.plugin}.`);
    else if (name === 'ext:uninstall') done(await skills.uninstall(msg.plugin, msg.market), `Removed ${msg.plugin}.`);
    else if (name === 'ext:market') { const e = await skills.addMarketplace(msg.source); reply({ error: e, done: e ? '' : `Added the ${msg.source} marketplace.` }); }
    else if (name === 'ext:github') { const r = await skills.addFromGitHub(msg.repo); done(r.error && !r.added.length ? r.error : '', `Added ${r.added.join(', ')}.`); }
    else if (name === 'ext:skill-remove') done(skills.removeOwn(msg.id), 'Removed the skill.');
    else if (name === 'ext:mcp-add') { const e = await mcp.add(msg.server, msg.target); if (!e) await mcp.check(); done(e, `Added ${msg.server}. If it needs you to sign in, run "claude" in a terminal and type /mcp.`); }
    else if (name === 'ext:mcp-remove') done(await mcp.remove(msg.server), `Removed ${msg.server}.`);
  } catch (e) { log(`extensions: ${name} failed: ${e.message}`); reply({ error: e.message }); }
}

const NAME_OK = /^[A-Z0-9][A-Z0-9 .'-]{1,19}$/;
const wakeList = (v) => [...new Set(String(v || '').toLowerCase().split(',').map((w) => w.replace(/[^a-z0-9 ']/g, '').trim()).filter((w) => w.length >= 3))].slice(0, 6);

/** The Agents tab: make a new assistant from another one, change one, or delete one of the user's own. */
function editAssistant(kind, b = {}) {
  const fail = (text) => hud && hud.send('assistant-error', { text });
  if (kind === 'assistant-create') {
    const from = exists(b.from, cfg) ? b.from : cfg.assistant;
    const src = assistantOf(from, cfg);
    const name = String(b.title || '').trim().toUpperCase();
    if (!NAME_OK.test(name)) return fail('Give it a name of 2 to 20 letters or numbers.');
    if (findByName(name, cfg)) return fail(`There is already an assistant called ${name}.`);
    const id = newId(name, cfg);
    const own = (cfg.assistantSettings || {})[from] || {};
    const settings = { ...src.settings, ...Object.fromEntries(SCOPED.filter((k) => k in own).map((k) => [k, own[k]])), wakeWords: [name.toLowerCase()] };
    C.saveCustom(id, { name, tier: 'YOUR OWN', about: `Started from ${src.name}.`, needs: src.needs, hello: '', persona: src.persona, settings });
    if (own.skills || own.mcp) C.saveProfile(id, { skills: own.skills || null, mcp: own.mcp || null });
    log(`assistant: made ${name} from ${src.name}`);
    Object.assign(cfg, C.load());
    sendAssistants({ edit: id });
    return;
  }
  const id = b.id;
  if (!exists(id, cfg)) return;
  const custom = (cfg.customAssistants || {})[id];
  if (kind === 'assistant-delete') {
    if (!custom) return fail('The built-in assistants can be reset, not deleted.');
    if (id === cfg.assistant) return fail(`Switch to another assistant before deleting ${custom.name}.`);
    C.saveCustom(id, null);
    log(`assistant: deleted ${custom.name}`);
    Object.assign(cfg, C.load());
    sendAssistants();
    return;
  }
  // assistant-update
  if (custom) {
    const name = 'title' in b ? String(b.title || '').trim().toUpperCase() : custom.name;
    if (!NAME_OK.test(name)) return fail('Give it a name of 2 to 20 letters or numbers.');
    const other = findByName(name, cfg);
    if (other && other !== id) return fail(`There is already an assistant called ${name}.`);
    C.saveCustom(id, { ...custom, name, tier: String(b.tier ?? custom.tier).trim().toUpperCase().slice(0, 24) || 'YOUR OWN', about: String(b.about ?? custom.about).trim().slice(0, 200) });
  }
  const fields = {};
  if ('persona' in b) {
    const p = String(b.persona || '').trim().slice(0, 4000);
    const def = (ASSISTANTS[id] || custom).persona;
    fields.persona = !p || p === def ? null : p;
  }
  // Skills and MCP servers: a list of ids or names, or 'all'.
  for (const k of ['skills', 'mcp']) {
    if (!(k in b)) continue;
    fields[k] = b[k] === 'all' || !Array.isArray(b[k]) ? null : b[k].map(String).filter((x) => x.length < 200).slice(0, 500);
  }
  if ('wakeWords' in b) {
    const w = wakeList(b.wakeWords);
    if (!w.length) return fail('Give at least one wake word of three letters or more.');
    fields.wakeWords = w;
  }
  C.saveProfile(id, fields);
  if (b.settings && typeof b.settings === 'object') C.saveSettings(id, b.settings);
  log(`assistant: changed ${assistantOf(id, cfg).name} (${Object.keys(b).filter((k) => !['id', 'type', 'name'].includes(k)).join(', ')})`);
  if (id === cfg.assistant) refreshCurrent('The change'); else { Object.assign(cfg, C.load()); sendAssistants(); }
}

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
    workerAvailable: !!(orch && orch.brain.worker),
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
  const sc = setupContents();
  if (sc) sc.send('theme', { theme: c.theme, mode: c.themeMode });
}

ipcMain.handle('setup:clear-secret', (e, key) => { if (fromSetup(e) && C.SECRET_KEYS.has(key)) C.save({ [key]: '' }); return true; });

/** Check a key or server: { ok, msg, models | voices }. */
async function testKey(kind, key) {
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
}
ipcMain.handle('setup:test', (e, { kind, key } = {}) => (fromSetup(e) ? testKey(kind, key) : { ok: false }));

// Permissions from Setup (and Settings): check them all, or ask for one. Always the real speech helper,
// because macOS grants access per app, whatever the tests run as the microphone.
async function permissionsCall({ action, which } = {}) {
  const perms = require('./permissions');
  const earsBin = sidecarPath(true);
  if (action === 'ask') {
    const s = await perms.ask(which, {
      earsBin,
      openPane: (pane) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`),
      // Tests skip the real banner: it sits over the screen and catches the mouse.
      notify: (title, body) => { if (process.env.JARVIS_TEST_MUTE) { log(`notify (test): ${title}: ${body}`); return; } try { new Notification({ title, body }).show(); } catch {} },
    });
    if (which === 'ax' || which === 'screen') checkHands().then(sendHudSettings);
    return s;
  }
  return perms.state(earsBin);
}
ipcMain.handle('setup:permissions', (e, opts) => (fromSetup(e) ? permissionsCall(opts) : null));

// Ollama from Setup or Settings: state, start, install the app, download a model, with progress.
async function ollamaCall({ action, url, model } = {}, progress = () => {}) {
  const ollama = require('./ollama');
  const where = url || C.load().ollamaUrl;
  if (action === 'state') return ollama.state(where);
  if (action === 'start') return ollama.start(where);
  if (action === 'install') return ollama.install(where, progress);
  if (action === 'pull') return ollama.pull(where, model, progress);
  return { ok: false };
}
ipcMain.handle('setup:ollama', (e, opts) => (fromSetup(e) ? ollamaCall(opts, (p) => { const sc = setupContents(); if (sc) sc.send('ollama-progress', p); }) : { ok: false }));

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

async function installHooks() {
  const r = await run('/bin/sh', [path.join(paths.scripts, 'install-hooks.sh')], { timeout: 20000 });
  return { ok: r.code === 0, msg: (r.out + r.err).trim().slice(0, 300) };
}
ipcMain.handle('setup:install-hooks', (e) => (fromSetup(e) ? installHooks() : { ok: false }));

ipcMain.handle('setup:open', (e, url) => { if (fromSetup(e) && /^(https:\/\/|x-apple\.systempreferences:)/.test(url)) shell.openExternal(url); });

/** After a save while running: apply what can change live, and say whether the rest needs a restart. */
function applySaved() {
  if (!orch) return { restart: false };
  const fresh = C.load();
  const live = {}, later = [];
  for (const k of Object.keys(fresh)) {
    if (JSON.stringify(fresh[k]) === JSON.stringify(cfg[k])) continue;
    if (HUD_KEYS.includes(k)) live[k] = fresh[k];
    else if (!['theme', 'themeMode', 'onboarded'].includes(k)) later.push(k);
  }
  if (Object.keys(live).length) saveHudSettings(live);
  log(`settings: applied ${Object.keys(live).join(', ') || 'nothing'} live${later.length ? `; restart needed for ${later.join(', ')}` : ''}`);
  return { restart: later.length > 0, keys: later };
}
ipcMain.handle('setup:apply', (e) => (fromSetup(e) ? applySaved() : { restart: false }));

function relaunch() {
  log('settings: relaunching');
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--setup') });
  app.exit(0);
}

/**
 * The HUD's Settings tab: each card opens its section inside the Settings box, using the same
 * functions as Setup. Requests come as cfg:* actions; answers go back as cfg-* events.
 */
async function hudSettingsAction(name, msg = {}) {
  const reply = (type, payload) => hud && hud.send(type, payload);
  try {
    if (name === 'cfg:info') reply('cfg-info', await setupInfo());
    else if (name === 'cfg:test') reply('cfg-test', { kind: msg.kind, ...(await testKey(msg.kind, msg.key)) });
    else if (name === 'cfg:ollama') reply('cfg-ollama', { action: msg.action, model: msg.model, ...(await ollamaCall(msg, (p) => reply('cfg-ollama-progress', p))) });
    else if (name === 'cfg:perms') reply('cfg-perms', (await permissionsCall({ action: msg.op, which: msg.which })) || {});
    else if (name === 'cfg:hooks') reply('cfg-hooks', await installHooks());
    else if (name === 'cfg:save') { setupSave(msg.patch); reply('cfg-saved', applySaved()); }
    else if (name === 'cfg:restart') relaunch();
  } catch (e) { log(`settings: ${name} failed: ${e.message}`); reply('cfg-error', { action: name, msg: e.message }); }
}

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
  relaunch();
});
