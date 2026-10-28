// JARVIS — Electron entry point. Menu bar item, HUD window, setup window,
// and the orchestrator that runs everything else.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, ipcMain, shell, safeStorage, Notification, dialog } = require('electron');
const C = require('./config');
const { ASSISTANTS, SCOPED, ROLES, TOOLS, GUARDS, PROFILE, assistantOf, allAssistants, findByName, newId, exists } = require('./assistants');
const { log, initPaths, paths, run, which } = require('./util');
const { Memory, ownFile } = require('./memory');

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
  // How long each step of the start takes, so a slow start says where the time went.
  let t0 = Date.now();
  const lap = (what) => { const ms = Date.now() - t0; if (ms > 250) log(`startup: ${what} took ${ms} ms`); t0 = Date.now(); };
  const AudioHost = require('./audio-host');
  const HudWindow = require('./hud-window');
  const { Ears, vocabulary } = require('./ears');
  const { Orchestrator } = require('./orchestrator');

  audio = testAudio || new AudioHost();
  hud = new HudWindow(themeOf(cfg));
  const brain = brains.create(cfg, found);
  const ears = new Ears(cfg, sidecarPath(), vocabulary(cfg));
  lap('the window, brain and ears');
  orch = new Orchestrator({ cfg, brain, ears, audio, hud, found });
  lap('the orchestrator');
  hud.send('info', { claude: found.claude.version || 'not installed', model: brain.label, voice: cfg.ttsEngine });
  if (brain.fallback) hud.send('notice', { text: `${assistantOf(cfg.assistant, cfg).name} needs ${brain.fallback}, so it is thinking with ${brain.label} for now.` });

  buildTray();
  orch.on('state', updateTrayTitle);
  orch.on('disabled', buildTray);
  orch.on('open-setup', (section) => openSettings(section));
  hud.on('action', (name, msg) => { if (name.startsWith('cfg:')) hudSettingsAction(name, msg); else if (name.startsWith('ext:')) extensionsAction(name, msg); else if (name.startsWith('dev:')) devicesAction(name, msg); });
  orch.on('set-theme', (t) => saveTheme(t));
  orch.on('settings', (patch) => saveHudSettings(patch));
  orch.on('hands-permit', permitHands);
  orch.on('notify', (title, body) => { try { new Notification({ title, body }).show(); } catch {} });
  orch.on('telegram-push', (text) => { if (telegram && cfg.telegramChatId) telegram.send(cfg.telegramChatId, text); });
  orch.on('switch-assistant', switchAssistant);
  orch.on('reset-assistant', resetAssistant);
  orch.on('assistant-edit', editAssistant);
  orch.on('refresh-assistant', () => refreshCurrent('The change'));
  lap('the tray and events');
  sendHudSettings();
  sendAssistants();
  checkHands().then(sendHudSettings);
  ears.on('devices', buildTray);
  lap('settings and agents for the HUD');

  if (cfg.telegramToken) {
    const Telegram = require('./telegram');
    telegram = new Telegram(cfg, orch);
    telegram.on('status', (s) => { orch.telegramStatus = s; hud.send('notice', { text: `Telegram: ${s}` }); buildTray(); });
    telegram.start();
  }
  // Other devices first: the rest of the start (music, radio lists) can take a while on a slow Mac.
  startDevices();
  lap('other devices');
  orch.start(!flags.has('--no-voice'));
  lap('the orchestrator start');
  watchRestart();
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
  if (devices) devices.stop();
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
  'model', 'effort', 'agentModel', 'screenControl', 'morningBriefing', 'checkIns', 'honorific', 'announceSessions', 'autoHide', 'worker', 'greetOnStart'];

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
    // The roles and tools to choose from.
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, r.label])),
    tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { label: t.label, about: t.about }])),
    guards: Object.fromEntries(Object.entries(GUARDS).map(([k, g]) => [k, { label: g.label, about: g.about }])),
    list: allAssistants(cfg).map((a) => {
      const own = mine[a.id] || {};
      const def = ASSISTANTS[a.id] || (cfg.customAssistants || {})[a.id] || {};
      return {
        id: a.id, name: a.name, tier: a.tier, about: a.about, needs: a.needs, custom: a.custom, persona: a.persona,
        defaultPersona: def.persona || '', defaultRole: def.role || 'none',
        role: a.role, roleText: a.roleText, commands: a.commands, tools: a.tools, color: a.color, sharedMemory: a.sharedMemory,
        guard: a.guard, blockedPaths: a.blockedPaths, maintainer: a.maintainer, defaultMaintainer: !!def.maintainer,
        // Its training: the facts only it keeps.
        memory: new Memory(ownFile(a.id)).facts,
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

/**
 * The agent that maintains JARVIS asks for a restart (scripts/maintain.sh restart) after it built an
 * update. JARVIS restarts itself once it is idle: nothing being said, no answer or job in progress.
 * A request left from before this start is already done.
 */
const RESTART_FILE = path.join(C.STATE_DIR, 'restart-request.json');
function watchRestart() {
  try { fs.unlinkSync(RESTART_FILE); } catch {}
  let going = false, said = 0;
  setInterval(() => {
    if (going || !orch || !fs.existsSync(RESTART_FILE)) return;
    if (!orch.isIdle || orch.progress.size) {
      // Say what it is waiting for, once a minute, so a restart that never comes can be explained.
      if (Date.now() - said > 60000) {
        said = Date.now();
        log(`restart: waiting (state ${orch._state}, brain ${orch.brain.isBusy ? 'busy' : 'free'}, ${orch.speaker.isSpeaking ? 'speaking' : 'quiet'}, jobs: ${[...orch.progress.values()].map((j) => j.description).join('; ') || 'none'})`);
      }
      return;
    }
    let why = 'maintenance';
    try { why = String(JSON.parse(fs.readFileSync(RESTART_FILE, 'utf8')).reason || why).slice(0, 200); } catch {}
    try { fs.unlinkSync(RESTART_FILE); } catch {}
    going = true;
    log(`restart: for ${why}`);
    hud && hud.send('notice', { text: `Restarting for ${why}.` });
    orch.speaker.speak(`Restarting for an update, ${cfg.honorific}. Back in a moment.`);
    setTimeout(() => { app.relaunch(); app.quit(); }, 4000);
  }, 3000);
}

// ---------- JARVIS on the user's other devices (devices.js) ----------

let devices = null, peerWorker = null;
const peerJobs = new Map();   // worker job id -> { peer, req }

function sendDevices(extra = {}) {
  if (!hud || !devices) return;
  hud.send('devices', { name: devices.data.name, list: devices.list(), relay: devices.data.relay, pairing: devices.pairing ? { role: devices.pairing.role } : null, ...extra });
}

function startDevices() {
  const { Devices } = require('./devices');
  devices = new Devices();
  // What this device is doing, for another device asking "what's it up to?".
  devices.extraStatus = () => ({ assistant: orch ? orch.name : '', busy: orch ? !orch.isIdle : false, jobs: orch ? [...orch.progress.values()].map((j) => j.description) : [], peerJobs: [...peerJobs.values()].map((j) => j.description) });
  devices.on('change', () => sendDevices());
  devices.on('pair', (e) => { sendDevices({ pair: e }); if (e.state === 'paired') { hud.send('notice', { text: `Paired with ${e.name}.` }); orch.speaker.speak(`Paired with ${e.name}, ${cfg.honorific}.`); } });
  devices.on('task', runPeerTask);
  mirrorHud();
  // Another device's HUD, shown here in its tab.
  devices.on('remote', (p, d) => hud && hud.send('remote', { device: p.id, ...d }));
  // Typed in this device's tab on another of the user's devices: a turn here, read there.
  devices.on('say', (p, text, voice) => { log(`devices: ${p.name} ${voice ? 'said' : 'typed'} '${text.slice(0, 60)}'`); orch.action('peer-type', { text, from: p.name, replyTo: voice ? p.id : '' }); });
  // Said here while another computer's tab was open: it went there, and its answer is spoken here.
  orch.on('remote-say', (id, text) => devices.sayTo(id, text, true).then((e) => { if (e) orch.remoteAnswer(e); }));
  devices.on('said', (p, text) => orch.remoteAnswer(text));
  orch.on('peer-reply', (id, text) => { const p = devices.peer(id); if (p) devices.deliver(p, { t: 'said', text: String(text || '').slice(0, 4000) }); });
  devices.on('act', (p, a) => remoteAct(p, a));
  devices.start().catch((e) => log(`devices: couldn't start: ${e.message}`));
  serveInbox();
}

// The HUD events another device needs to show this one: system and services, the core and its state,
// the agents, sessions, and the conversation on the right. Never memory, history, settings or music.
const MIRROR = new Set(['state', 'system', 'stats', 'info', 'sessions', 'assistants', 'assistant', 'assistant-error', 'assistant-try', 'conversation', 'ext']);
function mirrorHud() {
  const send = hud.send.bind(hud), raw = hud.sendRaw.bind(hud);
  const tap = (e) => {
    if (!MIRROR.has(e.type) || !devices) return;
    // An agent's training is its own memory, so it stays here.
    if (e.type === 'assistants' && Array.isArray(e.list)) e = { ...e, list: e.list.map(({ memory: _m, ...a }) => a), edit: undefined };
    devices.mirror(e);
  };
  hud.send = (type, payload = {}) => { send(type, payload); tap({ ...payload, type }); };
  hud.sendRaw = (type, data) => { raw(type, data); tap({ type, data }); };
  sendAssistants();
  orch.sendConversation();
  orch.sendStats();
  // The skills and servers here, for editing this device's agents from another one.
  try { hud.send('ext', { skills: require('./skills').catalog().map(({ path: _p, ...x }) => x), mcp: require('./mcp').list(), markets: [] }); } catch {}
  sendDevices();
}

/**
 * What another device's tab may change here: switch the agent, and change, add, delete, reset or try
 * agents. Never whether an agent may change JARVIS's code: that is only set on the machine itself.
 */
const REMOTE_ACTS = new Set(['assistant', 'assistant-update', 'assistant-create', 'assistant-delete', 'assistant-reset', 'assistant-try']);
function remoteAct(p, a) {
  const name = String(a.name || '');
  if (!REMOTE_ACTS.has(name)) { log(`devices: ${p.name} asked for '${name.slice(0, 40)}', which isn't allowed from another device`); return; }
  const { maintainer: _m, type: _t, name: _n, ...body } = a;
  log(`devices: ${p.name}: ${name}`);
  orch.action(name, body);
}

/**
 * A task from another of the user's devices runs here as a background job, with the assistant in use.
 * Its progress and result go back to that device.
 */
function runPeerTask(p, f) {
  const fail = (text) => devices.reply(p, f.id, { t: 'result', ok: false, text });
  if (!found || !found.claude || !found.claude.path || !found.claude.loggedIn) return fail(`${devices.data.name} can't run tasks: Claude Code isn't set up there.`);
  if (!f.task) return fail('The task was empty.');
  if (!peerWorker) {
    const { Worker } = require('./brain/worker');
    peerWorker = new Worker(cfg, found.claude.path);
    peerWorker.on('progress', (e) => { const j = peerJobs.get(e.id); if (j && e.status) devices.reply(j.peer, j.req, { t: 'progress', text: e.status }); });
    peerWorker.on('result', (r) => {
      const j = peerJobs.get(r.id);
      if (!j) return;
      peerJobs.delete(r.id);
      devices.reply(j.peer, j.req, { t: 'result', ok: r.ok, text: String(r.text || '').slice(0, 12000) });
      hud && hud.send('notice', { text: `Finished for ${j.peer.name}: ${j.description}` });
    });
  }
  const task = `[A TASK FROM THE USER'S OTHER DEVICE, "${p.name}"] The user asked for this on their other device, which handed it to you, on ${devices.data.name}. Do all of it here. If it says the user confirmed sending, posting, deleting or paying, they did, on that device. Otherwise stop before any such step and say in your result exactly what needs their yes.\n\n${f.task}`;
  const id = peerWorker.start(f.description, task);
  if (/^Error/.test(id)) return fail(id.replace(/^Error:\s*/, ''));
  peerJobs.set(id, { peer: p, req: f.id, description: f.description });
  log(`devices: running '${f.description}' for ${p.name}`);
  hud && hud.send('notice', { text: `Working for ${p.name}: ${f.description}` });
}

/**
 * A private socket (~/.jarvis/jarvis.sock, owner only) for scripts/devices.py, which the brain runs to
 * reach the other devices. One JSON request per connection, one JSON answer.
 */
function serveInbox() {
  const net = require('net');
  const sock = path.join(C.STATE_DIR, 'jarvis.sock');
  try { fs.unlinkSync(sock); } catch {}
  const server = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', async (d) => {
      buf += d;
      if (buf.length > 64000) return c.destroy();
      if (!buf.includes('\n')) return;
      let q = {};
      try { q = JSON.parse(buf.slice(0, buf.indexOf('\n'))); } catch {}
      let out;
      if (q.op === 'list') out = { ok: true, me: devices.data.name, devices: devices.list() };
      else if (q.op === 'status') out = await devices.status(String(q.device || ''));
      else if (q.op === 'ask') out = await devices.ask(String(q.device || ''), q.description, q.task);
      // Pairing from a script: show a code, or use one, and wait for the outcome.
      else if (q.op === 'pair-host' || q.op === 'pair-join') {
        const done = new Promise((resolve) => {
          const on = (e) => { if (e.state === 'paired' || e.state === 'expired') { devices.off('pair', on); resolve(e); } };
          devices.on('pair', on);
        });
        const r = await devices.pair(q.op === 'pair-host' ? 'host' : 'join', q.code);
        if (r.error) out = { ok: false, text: r.error };
        else if (q.op === 'pair-host' && !q.wait) out = { ok: true, code: r.code };
        else { const e = await Promise.race([done, new Promise((res) => setTimeout(() => res({ state: 'timeout' }), 180000))]); out = e.state === 'paired' ? { ok: true, text: `Paired with ${e.name}.` } : { ok: false, text: e.state === 'expired' ? 'The code ran out.' : 'No sign of the other device in 3 minutes.' }; }
      }
      else if (q.op === 'diag') out = { ok: true, ...devices.diag() };
      else if (q.op === 'unpair') { const e = devices.remove(String(q.device || '')); out = e ? { ok: false, text: e } : { ok: true, text: 'Unpaired.' }; }
      else if (q.op === 'pair-wait') {
        const e = await new Promise((resolve) => { const on = (x) => { if (x.state === 'paired' || x.state === 'expired') { devices.off('pair', on); resolve(x); } }; devices.on('pair', on); setTimeout(() => resolve({ state: 'timeout' }), 180000); });
        out = e.state === 'paired' ? { ok: true, text: `Paired with ${e.name}.` } : { ok: false, text: e.state === 'expired' ? 'The code ran out.' : 'Nothing paired in 3 minutes.' };
      }
      else out = { ok: false, text: 'Unknown request.' };
      try { c.end(JSON.stringify(out) + '\n'); } catch {}
    });
  });
  server.on('error', (e) => log(`inbox: ${e.message}`));
  server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch {} });
}

/** Settings › Devices: pairing, names, the relay. */
async function devicesAction(name, msg = {}) {
  if (!devices) return;
  const err = (text) => sendDevices({ error: text });
  if (name === 'dev:list') return sendDevices();
  // This HUD showing another device: type to it, change its agents, or load its view through the relay.
  // Which computer's tab is open, so what is said out loud goes there.
  if (name === 'dev:focus') { const p = msg.device ? devices.peer(msg.device) : null; orch.remoteTarget = p ? { id: p.id, name: p.name } : null; log(`remote: voice goes to ${p ? p.name : 'this computer'}`); return; }
  if (name === 'dev:say') { const e = await devices.sayTo(msg.device, msg.text); return e ? err(e) : null; }
  if (name === 'dev:act') { const e = await devices.actOn(msg.device, msg.action || {}); return e ? err(e) : null; }
  if (name === 'dev:view') { const r = await devices.fetchView(msg.device); if (!r.ok) err(r.text); return; }
  if (name === 'dev:name') { const e = devices.setName(msg.value); return e ? err(e) : sendDevices({ done: 'Saved.' }); }
  if (name === 'dev:relay') { const e = devices.setRelay({ on: msg.on, url: msg.url }); return e ? err(e) : sendDevices({ done: 'Saved.' }); }
  if (name === 'dev:remove') { const e = devices.remove(String(msg.id || '')); return e ? err(e) : sendDevices({ done: 'Removed.' }); }
  if (name === 'dev:cancel') { devices.cancelPair(); return sendDevices(); }
  if (name === 'dev:host' || name === 'dev:join') {
    try {
      const r = await devices.pair(name === 'dev:host' ? 'host' : 'join', msg.code);
      if (r.error) err(r.error);
    } catch (e) { log(`devices: pairing failed: ${e.message}`); err(`Couldn't start pairing: ${e.message}`); }
  }
}

const BLANK_PERSONA = 'A capable, friendly assistant: clear, direct and to the point.';

/**
 * The parts of an agent the user set in the Agents tab (or an imported file), checked: skills, MCP
 * servers and tools (lists, or 'all'), role, quick commands, colour and the shared-memory switch.
 * Missing keys are left alone; { error } when something doesn't fit.
 */
function profileFields(b) {
  const out = {};
  for (const k of ['skills', 'mcp']) {
    if (!(k in b)) continue;
    out[k] = b[k] === 'all' || !Array.isArray(b[k]) ? null : b[k].map(String).filter((x) => x.length < 200).slice(0, 500);
  }
  if ('tools' in b) out.tools = b.tools === 'all' || !Array.isArray(b.tools) ? null : b.tools.filter((t) => TOOLS[t]);
  if ('role' in b) {
    if (!ROLES[b.role]) return { error: 'Pick a role from the list.' };
    out.role = b.role;
  }
  if ('roleText' in b) out.roleText = String(b.roleText || '').trim().slice(0, 600) || null;
  if ('commands' in b) {
    const list = Array.isArray(b.commands) ? b.commands : [];
    out.commands = list.map((c) => ({ name: String((c && c.name) || '').replace(/^\/+/, '').trim().toLowerCase().slice(0, 30), prompt: String((c && c.prompt) || '').trim().slice(0, 600) }))
      .filter((c) => c.name && c.prompt).slice(0, 20);
    if (!out.commands.length) out.commands = null;
  }
  if ('color' in b) {
    const c = String(b.color || '').trim();
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) return { error: 'The colour should look like #3fd0ff.' };
    out.color = c.toLowerCase() || null;
  }
  if ('sharedMemory' in b) out.sharedMemory = b.sharedMemory === false ? false : null;
  if ('maintainer' in b) out.maintainer = typeof b.maintainer === 'boolean' ? b.maintainer : null;
  if ('guard' in b) {
    if (!GUARDS[b.guard]) return { error: 'Pick a safety level from the list.' };
    out.guard = b.guard;
  }
  if ('blockedPaths' in b) {
    const list = [];
    for (const raw of Array.isArray(b.blockedPaths) ? b.blockedPaths : String(b.blockedPaths || '').split('\n')) {
      const t = String(raw || '').trim();
      if (!t) continue;
      const p = path.resolve(t.replace(/^~(?=\/|$)/, C.HOME));
      if (!p.startsWith('/') || p === '/' || p.length > 300) return { error: `${t} is not a folder path.` };
      if (!list.includes(p)) list.push(p);
    }
    out.blockedPaths = list.length ? list.slice(0, 30) : null;
  }
  return out;
}

/** "Try it" in the Agents tab: one reply from that agent, without switching to it. */
async function tryAssistant(id, text) {
  text = String(text || '').trim().slice(0, 2000);
  if (!text || !hud) return;
  const name = assistantOf(id, cfg).name;
  log(`assistant: trying ${name}`);
  try {
    const reply = String(await require('./brain').tryAgent(C.load(id), found || {}, text)).trim();
    hud.send('assistant-try', { id, text: reply || '(no reply)' });
  } catch (e) {
    log(`assistant: trying ${name} failed: ${e.message}`);
    hud.send('assistant-try', { id, error: `${name} couldn't answer. ${String(e.message || e).slice(0, 200)}` });
  }
}

/** Save an agent to a file: who it is, its role, prompts, tools, skills, settings and training. No keys. */
async function exportAssistant(id) {
  const a = assistantOf(id, cfg);
  const live = C.load(id);
  const own = (cfg.assistantSettings || {})[id] || {};
  const data = {
    jarvisAgent: 1, name: a.name, tier: a.tier, about: a.about, persona: a.persona, role: a.role, roleText: a.roleText,
    commands: a.commands, tools: a.tools, color: a.color, sharedMemory: a.sharedMemory, guard: a.guard, blockedPaths: a.blockedPaths,
    settings: { ...Object.fromEntries(SCOPED.map((k) => [k, live[k]])), wakeWords: own.wakeWords || a.settings.wakeWords || [] },
    skills: Array.isArray(own.skills) ? own.skills : null, mcp: Array.isArray(own.mcp) ? own.mcp : null,
    training: new Memory(ownFile(id)).facts.map((f) => f.text),
  };
  const r = await dialog.showSaveDialog(hud.win, { title: `Export ${a.name}`, defaultPath: path.join(app.getPath('downloads'), `${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jarvis-agent.json`), filters: [{ name: 'JARVIS agent', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 1), { mode: 0o600 });
  log(`assistant: exported ${a.name}`);
  hud.send('notice', { text: `Saved ${a.name} to ${path.basename(r.filePath)}.` });
}

/**
 * An agent from a file someone exported. It becomes one of the user's own, under a free name. The file is
 * data: every field is checked as if typed in the Agents tab, and its persona goes in with the safety
 * rules still on top.
 */
async function importAssistant() {
  const fail = (text) => hud && hud.send('assistant-error', { text });
  const r = await dialog.showOpenDialog(hud.win, { title: 'Import an agent', properties: ['openFile'], filters: [{ name: 'JARVIS agent', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  let d;
  try { d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8').slice(0, 500000)); } catch { return fail('That file is not a JARVIS agent.'); }
  if (!d || d.jarvisAgent !== 1 || typeof d.name !== 'string') return fail('That file is not a JARVIS agent.');
  let name = d.name.trim().toUpperCase().replace(/[^A-Z0-9 .'-]/g, '').slice(0, 17);
  if (!NAME_OK.test(name)) name = 'IMPORTED';
  for (let i = 2; findByName(name, cfg); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
  const fields = profileFields(d);
  if (fields.error) return fail(`Couldn't import it: ${fields.error}`);
  // A file never makes an agent able to change JARVIS: only the user does, in the Agents tab.
  delete fields.error;
  delete fields.maintainer;
  const id = newId(name, cfg);
  const settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const wake = wakeList((settings.wakeWords || []).join(','));
  C.saveCustom(id, { name, tier: String(d.tier || 'YOUR OWN').toUpperCase().slice(0, 24), about: String(d.about || 'Imported.').slice(0, 200), needs: '', hello: '', persona: String(d.persona || BLANK_PERSONA).trim().slice(0, 4000), role: ROLES[d.role] ? d.role : 'none', settings: { wakeWords: wake.length ? wake : [name.toLowerCase()] } });
  C.saveProfile(id, fields);
  C.saveSettings(id, settings);
  const mem = new Memory(ownFile(id));
  for (const t of (Array.isArray(d.training) ? d.training : []).slice(0, 200)) mem.add(String(t).replace(/\s+/g, ' '), 'other');
  log(`assistant: imported ${name}`);
  Object.assign(cfg, C.load());
  sendAssistants({ edit: id });
}

/** The Agents tab: make a new assistant from another one, change one, or delete one of the user's own. */
function editAssistant(kind, b = {}) {
  const fail = (text) => hud && hud.send('assistant-error', { text });
  if (kind === 'assistant-create') {
    const name = String(b.title || '').trim().toUpperCase();
    if (!NAME_OK.test(name)) return fail('Give it a name of 2 to 20 letters or numbers.');
    if (findByName(name, cfg)) return fail(`There is already an assistant called ${name}.`);
    const id = newId(name, cfg);
    // A blank one: the defaults, a plain persona and no role. Otherwise a copy of the one it starts from.
    if (b.from === 'blank') {
      C.saveCustom(id, { name, tier: 'YOUR OWN', about: 'Made from scratch.', needs: 'Claude Code (or an API key)', hello: '', persona: BLANK_PERSONA, role: 'none', settings: { wakeWords: [name.toLowerCase()] } });
      log(`assistant: made ${name} from scratch`);
    } else {
      const from = exists(b.from, cfg) ? b.from : cfg.assistant;
      const src = assistantOf(from, cfg);
      const own = (cfg.assistantSettings || {})[from] || {};
      const settings = { ...src.settings, ...Object.fromEntries(SCOPED.filter((k) => k in own).map((k) => [k, own[k]])), wakeWords: [name.toLowerCase()] };
      C.saveCustom(id, { name, tier: 'YOUR OWN', about: `Started from ${src.name}.`, needs: src.needs, hello: '', persona: src.persona, role: src.role, roleText: src.roleText, settings });
      const copy = Object.fromEntries(PROFILE.filter((k) => !['persona', 'wakeWords', 'role', 'roleText'].includes(k) && k in own).map((k) => [k, own[k]]));
      if (Object.keys(copy).length) C.saveProfile(id, copy);
      log(`assistant: made ${name} from ${src.name}`);
    }
    Object.assign(cfg, C.load());
    sendAssistants({ edit: id });
    return;
  }
  if (kind === 'assistant-import') return importAssistant();
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
  if (kind === 'assistant-export') return exportAssistant(id);
  if (kind === 'assistant-try') return tryAssistant(id, b.text);
  if (kind === 'assistant-memory-add' || kind === 'assistant-memory-forget') {
    const mem = new Memory(ownFile(id));
    if (kind === 'assistant-memory-add') mem.add(String(b.text || '').replace(/\s+/g, ' '), 'other'); else mem.forget(String(b.fact || ''));
    log(`assistant: ${kind === 'assistant-memory-add' ? 'trained' : 'forgot a fact for'} ${assistantOf(id, cfg).name}`);
    // The brain in use reads its memory when it starts, so it starts again (quietly) to take it in.
    if (id === cfg.assistant) refreshCurrent('The training'); else sendAssistants();
    return;
  }
  const fields = profileFields(b);
  if (fields.error) return fail(fields.error);
  delete fields.error;
  // What matches the preset is the preset, so an agent saved unchanged isn't marked as changed.
  const def = ASSISTANTS[id] || custom;
  if (fields.role === (def.role || 'none')) fields.role = null;
  if (fields.guard === (def.guard || 'standard')) fields.guard = null;
  if ('maintainer' in fields && fields.maintainer === !!def.maintainer) fields.maintainer = null;
  if ('persona' in b) {
    const p = String(b.persona || '').trim().slice(0, 4000);
    const def = (ASSISTANTS[id] || custom).persona;
    fields.persona = !p || p === def ? null : p;
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
