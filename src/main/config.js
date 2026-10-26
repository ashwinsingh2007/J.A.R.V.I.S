// Runtime configuration: ~/.jarvis/config.json over the defaults below.
// Secrets (API keys, bot tokens) are encrypted with the macOS Keychain via
// Electron safeStorage and stored as "enc:<base64>".
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const STATE_DIR = process.env.JARVIS_STATE_DIR || path.join(HOME, '.jarvis');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const SECRET_KEYS = new Set(['anthropicApiKey', 'geminiApiKey', 'elevenLabsApiKey', 'telegramToken']);
const { ASSISTANTS, SCOPED, assistantOf } = require('./assistants');

const DEFAULTS = {
  onboarded: false,
  userName: '',
  honorific: 'sir',
  theme: 'jarvis',                // jarvis | terminal | neon | stark | minimal
  themeMode: 'dark',              // dark | light | system
  wakeWords: ['jarvis', 'jervis', 'jarvus', 'jar vis'],
  assistant: 'jarvis',            // which assistant is in use: jarvis | friday | karen | edith | vision (assistants.js)
  assistantSettings: {},          // the user's own changes, per assistant: { friday: { model: 'sonnet' } }

  // Brain: "auto" picks Claude Code, then the Anthropic API, then Gemini, then Ollama.
  brainProvider: 'auto',          // auto | claude-code | anthropic | gemini | ollama
  model: 'sonnet',                // Claude Code model alias
  effort: 'low',
  agentModel: 'opus',             // model for the background worker
  worker: 'claude-code',          // the background worker when the brain isn't Claude Code: claude-code | off
  progressUpdates: 'normal',
  screenControl: true,
  greetOnStart: true,             // "Online, sir. Say wake up when you need me." at start
  autoHide: true,                 // HOME hides its panels after a few idle seconds, leaving the reactor
  morningBriefing: true,          // briefing on the first "wake up" of the morning
  checkIns: 'sometimes',          // proactive check-ins while awake and quiet: off | sometimes (~3 h) | often (~90 min)            // agents may use Mac apps outside Chrome (Accessibility, mouse, keyboard), after asking      // spoken updates while agents work: off | normal (~35 s) | chatty (~20 s)
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-5-5',
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest', // Google's alias for the newest Flash model
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2',

  // Ears
  sttEngine: 'apple',             // apple (on-device) | elevenlabs (Scribe realtime)
  speechLocale: 'en-US',
  appleSpeech: 'instant',         // instant (classic dictation, word by word) | accurate (SpeechAnalyzer, ~1 s updates)
  commandSilenceSeconds: 3.0,
  pauseGraceSeconds: 6.0,
  endWords: ['over', 'over and out'],
  requireEndWord: false,

  // Mouth
  ttsEngine: 'kokoro',            // kokoro | elevenlabs | edge | native
  kokoroVoice: 'bm_george',
  kokoroSpeed: 1.05,
  edgeVoice: 'en-GB-RyanNeural',
  nativeVoice: 'Daniel',
  elevenLabsApiKey: '',
  elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',   // "George", British
  elevenLabsModel: 'eleven_flash_v2_5',
  maxSpokenSentences: 99,

  musicVolume: 0.3,
  musicStation: 'lofi',
  radioCountry: 'IN',
  radioFavourites: [],
  announceSessions: true,

  telegramToken: '',
  telegramChatId: 0,
  telegramVoiceReplies: true,
};

let safeStorage = null;
function attachSafeStorage(s) { safeStorage = s; }

function decrypt(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:')) return v;
  try { return safeStorage ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : ''; } catch { return ''; }
}

function encrypt(v) {
  if (!v || !safeStorage || !safeStorage.isEncryptionAvailable()) return v;
  return 'enc:' + safeStorage.encryptString(v).toString('base64');
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function writeRaw(json) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.keys(json).sort().map((k) => [k, json[k]]));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(sorted, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
}

/**
 * Before assistants, the brain, model and voice settings sat at the top level. They are the user's
 * own choices, so they become their changes to JARVIS.
 */
function migrate(raw) {
  if (raw.assistant) return false;
  const mine = {};
  for (const k of SCOPED) if (k in raw) { mine[k] = raw[k]; delete raw[k]; }
  raw.assistant = 'jarvis';
  raw.assistantSettings = { ...(raw.assistantSettings || {}), jarvis: { ...mine, ...((raw.assistantSettings || {}).jarvis || {}) } };
  return true;
}

function load() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const raw = readRaw();
  if (Object.keys(raw).length && migrate(raw)) writeRaw(raw);
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) cfg[k] = SECRET_KEYS.has(k) ? decrypt(v) : v;
  // The assistant's preset, then the user's own changes to it.
  if (!ASSISTANTS[cfg.assistant]) cfg.assistant = 'jarvis';
  const mine = (cfg.assistantSettings && typeof cfg.assistantSettings === 'object' && cfg.assistantSettings[cfg.assistant]) || {};
  for (const k of SCOPED) {
    if (k in assistantOf(cfg.assistant).settings) cfg[k] = assistantOf(cfg.assistant).settings[k];
    if (k in mine) cfg[k] = mine[k];
  }
  // Older Swift-app values
  if (cfg.sttEngine === 'analyzer' || cfg.sttEngine === 'legacy') cfg.sttEngine = 'apple';
  if (String(cfg.nativeVoice).startsWith('com.apple.')) cfg.nativeVoice = 'Daniel';
  return sanitize(cfg);
}

const ENUMS = {
  assistant: Object.keys(ASSISTANTS),
  brainProvider: ['auto', 'claude-code', 'anthropic', 'gemini', 'ollama'],
  sttEngine: ['apple', 'elevenlabs'],
  appleSpeech: ['instant', 'accurate'],
  ttsEngine: ['kokoro', 'elevenlabs', 'edge', 'native'],
  effort: ['low', 'medium', 'high'],
  agentModel: ['opus', 'sonnet', 'haiku', 'fable', 'inherit'],
  progressUpdates: ['off', 'normal', 'chatty'],
  worker: ['claude-code', 'off'],
  checkIns: ['off', 'sometimes', 'often'],
  theme: ['jarvis', 'terminal', 'neon', 'stark', 'minimal'],
  themeMode: ['dark', 'light', 'system'],
};
const RANGES = {
  commandSilenceSeconds: [0.5, 15], pauseGraceSeconds: [1, 30], kokoroSpeed: [0.5, 2],
  musicVolume: [0, 1], maxSpokenSentences: [1, 999],
};

/** Hand-edited or junk values fall back to something that works. */
function sanitize(cfg) {
  for (const [k, allowed] of Object.entries(ENUMS)) if (!allowed.includes(cfg[k])) cfg[k] = DEFAULTS[k];
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const n = Number(cfg[k]);
    cfg[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k];
  }
  const chat = Number(cfg.telegramChatId);
  cfg.telegramChatId = Number.isSafeInteger(chat) ? chat : 0;
  for (const k of ['honorific', 'model', 'anthropicModel', 'geminiModel', 'ollamaModel', 'ollamaUrl', 'speechLocale', 'kokoroVoice', 'edgeVoice', 'nativeVoice', 'elevenLabsVoiceId', 'elevenLabsModel']) {
    cfg[k] = typeof cfg[k] === 'string' && cfg[k].trim() ? cfg[k].trim() : DEFAULTS[k];
  }
  if (!/^https?:\/\/[^\s]+$/.test(cfg.ollamaUrl)) cfg.ollamaUrl = DEFAULTS.ollamaUrl;
  cfg.userName = typeof cfg.userName === 'string' ? cfg.userName.trim().slice(0, 40) : '';
  if (!cfg.assistantSettings || typeof cfg.assistantSettings !== 'object' || Array.isArray(cfg.assistantSettings)) cfg.assistantSettings = {};
  for (const k of ['wakeWords', 'endWords']) {
    cfg[k] = Array.isArray(cfg[k]) ? cfg[k].filter((w) => typeof w === 'string' && w.trim()).map((w) => w.toLowerCase()) : DEFAULTS[k];
    if (k === 'wakeWords' && !cfg[k].length) cfg[k] = DEFAULTS[k];
  }
  return cfg;
}

/** Persist one or more keys. Secrets are encrypted at rest. An assistant's settings go to that assistant. */
function save(patch) {
  const raw = readRaw();
  migrate(raw);
  if (patch.assistant && ASSISTANTS[patch.assistant]) raw.assistant = patch.assistant;
  const who = ASSISTANTS[raw.assistant] ? raw.assistant : 'jarvis';
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'assistant') continue;
    if (SCOPED.includes(k)) {
      raw.assistantSettings = raw.assistantSettings || {};
      raw.assistantSettings[who] = { ...(raw.assistantSettings[who] || {}), [k]: v };
    } else raw[k] = SECRET_KEYS.has(k) ? encrypt(v) : v;
  }
  writeRaw(raw);
}

/** Forget the user's changes to one assistant, so it is back to its preset. */
function resetAssistant(id) {
  const raw = readRaw();
  migrate(raw);
  if (raw.assistantSettings) delete raw.assistantSettings[id];
  writeRaw(raw);
}

/** Directory holding scripts/, prompts/, models/, .venv/ (dev: repo root; packaged: walk up from the app). */
function findProjectRoot(start) {
  if (process.env.JARVIS_HOME) return process.env.JARVIS_HOME;
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'sessions.sh'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

module.exports = {
  HOME, STATE_DIR, CONFIG_FILE, DEFAULTS, SECRET_KEYS,
  LOG_FILE: path.join(STATE_DIR, 'jarvis.log'),
  SESSION_FILE: path.join(STATE_DIR, 'brain-session.txt'),
  BRAIN_SESSIONS_FILE: path.join(STATE_DIR, 'brain-sessions.txt'),
  MEMORY_FILE: path.join(STATE_DIR, 'memory.md'),
  EVENTS_FILE: path.join(STATE_DIR, 'events.jsonl'),
  attachSafeStorage, load, save, resetAssistant, sanitize, findProjectRoot,
};
