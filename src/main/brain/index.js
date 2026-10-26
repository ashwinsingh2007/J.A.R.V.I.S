// Picks the brain: Claude Code if installed and signed in, else the Anthropic
// API if a key is set, else Gemini if a key is set, else a local Ollama model.
// "brainProvider" in the config forces one.
const { which, run, log } = require('../util');
const ClaudeCodeBrain = require('./claude-code');
const ApiBrain = require('./api-brain');
const { Worker } = require('./worker');

/** What is available on this Mac. Used by onboarding and at start-up. */
async function detect(cfg) {
  const out = { claude: { path: null, version: '', loggedIn: false }, anthropic: { key: !!cfg.anthropicApiKey }, gemini: { key: !!cfg.geminiApiKey }, ollama: { running: false, models: [] } };
  const claude = which('claude');
  if (claude) {
    out.claude.path = claude;
    out.claude.version = (await run(claude, ['--version'], { timeout: 15000 })).out.trim();
    const auth = (await run(claude, ['auth', 'status'], { timeout: 15000 })).out;
    out.claude.loggedIn = /"loggedIn":\s*true/.test(auth);
  }
  try {
    const r = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { out.ollama.running = true; out.ollama.models = ((await r.json()).models || []).map((m) => m.name); }
  } catch {}
  return out;
}

function choose(cfg, found) {
  const want = cfg.brainProvider || 'auto';
  if (want === 'claude-code' || (want === 'auto' && found.claude.path && found.claude.loggedIn)) {
    if (found.claude.path) return 'claude-code';
  }
  if (want === 'anthropic' || (want === 'auto' && cfg.anthropicApiKey)) {
    if (cfg.anthropicApiKey) return 'anthropic';
  }
  if (want === 'gemini' || (want === 'auto' && cfg.geminiApiKey)) {
    if (cfg.geminiApiKey) return 'gemini';
  }
  if (want === 'ollama' || want === 'auto') return 'ollama';
  return found.claude.path ? 'claude-code' : cfg.anthropicApiKey ? 'anthropic' : cfg.geminiApiKey ? 'gemini' : 'ollama';
}

function create(cfg, found) {
  const kind = choose(cfg, found);
  log(`brain: provider ${kind} (setting: ${cfg.brainProvider})`);
  if (kind === 'claude-code') return new ClaudeCodeBrain(cfg, found.claude.path);
  if (kind === 'ollama' && found.ollama.models.length && !found.ollama.models.some((m) => m === cfg.ollamaModel || m.startsWith(cfg.ollamaModel + ':'))) {
    log(`brain: ollama model ${cfg.ollamaModel} not installed; using ${found.ollama.models[0]}`);
    cfg = { ...cfg, ollamaModel: found.ollama.models[0] };
  }
  // The background worker takes heavy jobs off a brain that isn't Claude Code, when Claude Code is here to run it.
  // The worker setting is read per turn, so switching her off in Settings applies at once.
  const worker = found.claude.path && found.claude.loggedIn ? new Worker(cfg, found.claude.path) : null;
  log(`brain: worker ${worker ? `on Claude Code · ${cfg.agentModel}${cfg.worker === 'off' ? ' (switched off)' : ''}` : 'none (Claude Code not available)'}`);
  return new ApiBrain(cfg, kind, worker);
}

module.exports = { detect, create, choose };
