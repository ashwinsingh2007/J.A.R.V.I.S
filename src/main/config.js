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

const DEFAULTS = {
  onboarded: false,
  userName: '',
  honorific: 'sir',
  theme: 'jarvis',                // jarvis | terminal | neon | stark | minimal
  themeMode: 'dark',              // dark | light | system
  wakeWords: ['jarvis', 'jervis', 'jarvus', 'jar vis'],

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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, Object.keys(json).sort(), 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
}

function load() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const raw = readRaw();
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) cfg[k] = SECRET_KEYS.has(k) ? decrypt(v) : v;
  // Older Swift-app values
  if (cfg.sttEngine === 'analyzer' || cfg.sttEngine === 'legacy') cfg.sttEngine = 'apple';
  if (String(cfg.nativeVoice).startsWith('com.apple.')) cfg.nativeVoice = 'Daniel';
  return sanitize(cfg);
}

const ENUMS = {
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
  for (const k of ['wakeWords', 'endWords']) {
    cfg[k] = Array.isArray(cfg[k]) ? cfg[k].filter((w) => typeof w === 'string' && w.trim()).map((w) => w.toLowerCase()) : DEFAULTS[k];
    if (k === 'wakeWords' && !cfg[k].length) cfg[k] = DEFAULTS[k];
  }
  return cfg;
}

/** Persist one or more keys. Secrets are encrypted at rest. */
function save(patch) {
  const raw = readRaw();
  for (const [k, v] of Object.entries(patch)) raw[k] = SECRET_KEYS.has(k) ? encrypt(v) : v;
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
  attachSafeStorage, load, save, sanitize, findProjectRoot,
};
