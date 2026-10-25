// Setup / onboarding wizard. Reads detection results from the main process,
// lets the user choose brain, ears and voice, saves to ~/.jarvis/config.json.
const $ = (id) => document.getElementById(id);
const FIRST = new URLSearchParams(location.search).get('first') === '1';
const STEPS = ['welcome', 'look', 'brain', 'ears', 'voice', 'access', 'extras', 'finish'];
const TEXT = ['userName', 'honorific', 'model', 'effort', 'worker', 'agentModel', 'anthropicModel', 'geminiModel', 'ollamaUrl', 'ollamaModel', 'speechLocale', 'appleSpeech', 'kokoroVoice', 'elevenLabsVoiceId', 'elevenLabsModel', 'edgeVoice', 'nativeVoice', 'radioCountry'];
const NUM = ['commandSilenceSeconds', 'kokoroSpeed', 'telegramChatId'];
const BOOL = ['requireEndWord', 'telegramVoiceReplies'];
const SECRET = ['anthropicApiKey', 'geminiApiKey', 'elevenLabsApiKey', 'telegramToken'];

let info = null;
let ol = { installed: false, running: false, models: [], recommended: [] };   // Ollama, as main reports it
let olBusy = '';                       // '', 'install', 'start' or a model being downloaded
const tested = {};                     // anthropic / gemini: the typed key passed Test
let step = 0;
let furthest = 0;   // first run: steps up to here can be revisited by clicking
const choice = { brainProvider: 'auto', sttEngine: 'apple', ttsEngine: 'kokoro', theme: 'jarvis', themeMode: 'dark' };

function status(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'bad');
  if (cls) el.classList.add(cls);
}

function show(i) {
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  furthest = Math.max(furthest, step);
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.dataset.step === STEPS[step]));
  document.querySelectorAll('#steps li').forEach((li, n) => { li.classList.toggle('on', n === step); li.classList.toggle('done', FIRST && n < furthest && n !== step); li.classList.toggle('locked', FIRST && n > furthest); });
  document.querySelector('.scroll').scrollTop = 0;
  $('back').disabled = step === 0;
  $('next').textContent = step === STEPS.length - 1 ? (FIRST ? 'Start JARVIS' : 'Save & restart') : 'Next';
  if (STEPS[step] === 'finish') renderSummary();
  if (STEPS[step] === 'access') refreshPerms();
  else if (STEPS[step] !== 'finish') status($('saved'), '');
  updateNext();
}

// ---------- permissions ----------

let perms = {};
let notified = false;
const PERM_TEXT = { allowed: ['✓ allowed', 'ok'], 'not-asked': ['not yet', 'warn'], denied: ['✗ not allowed', 'bad'], unknown: ['—', ''], absent: ['not installed', ''] };

function renderPerms() {
  document.querySelectorAll('#perms li').forEach((li) => {
    const k = li.dataset.perm;
    const st = k === 'notifications' ? (notified ? 'allowed' : 'not-asked') : perms[k] || 'unknown';
    const [label, cls] = k === 'notifications' && notified ? ['✓ test sent', 'ok'] : PERM_TEXT[st] || PERM_TEXT.unknown;
    status(li.querySelector('.chip'), label, cls);
    const btn = li.querySelector('button');
    btn.hidden = st === 'allowed' || st === 'absent';
    btn.textContent = st === 'denied' ? 'Open Settings' : k === 'notifications' ? 'Send a test' : 'Allow';
    li.classList.toggle('done', st === 'allowed');
  });
  const missing = ['mic', 'speech'].filter((k) => perms[k] && perms[k] !== 'allowed');
  if (STEPS[step] === 'access') status($('saved'), missing.length ? 'JARVIS cannot hear you until the microphone and speech recognition are allowed.' : '', missing.length ? 'bad' : '');
}

async function refreshPerms() {
  perms = (await window.setup.permissions('state')) || {};
  renderPerms();
}

/** The Brain step only lets you on once the chosen brain works. */
function updateNext() {
  const why = STEPS[step] === 'brain' ? brainProblem() : null;
  $('next').disabled = !!why;
  status($('brain-msg'), why || '', why ? '' : 'ok');
}

/** Why the chosen brain can't be used yet, or null when it's ready. */
function brainProblem() {
  const f = info.found, b = choice.brainProvider;
  if (b === 'claude-code') {
    if (!f.claude.path) return 'Claude Code is not installed on this Mac. Pick Ollama for a free brain, or install Claude Code.';
    if (!f.claude.loggedIn) return 'Claude Code needs you to sign in once: run claude in Terminal.';
    return null;
  }
  if (b === 'ollama') {
    if (olBusy) return 'Working on it…';
    if (!ol.installed) return 'Install Ollama to continue.';
    if (!ol.running) return 'Start Ollama to continue.';
    if (!hasModel($('ollamaModel').value)) return 'Download a model to continue.';
    return null;
  }
  if (b === 'anthropic' || b === 'gemini') {
    const key = b === 'anthropic' ? 'anthropicApiKey' : 'geminiApiKey';
    const typed = $(key).value.trim();
    if (!typed && !info.cfg[`has_${key}`]) return `Paste your ${b === 'anthropic' ? 'Anthropic' : 'Gemini'} API key, then press Test.`;
    if (typed && tested[b] === false) return 'That key was rejected. Check it and press Test again.';
    if (typed && !tested[b]) return 'Press Test to check the key.';
    return null;
  }
  return null;
}

/** The best brain this Mac can use right now. */
function bestBrain() {
  const f = info.found;
  if (f.claude.path && f.claude.loggedIn) return 'claude-code';
  if (info.cfg.has_anthropicApiKey) return 'anthropic';
  if (info.cfg.has_geminiApiKey) return 'gemini';
  return 'ollama';
}

/** FRIDAY runs on Claude Code: as its background agents when it is the brain, or as a separate worker. */
function renderWorker() {
  const f = info.found, cc = !!(f.claude.path && f.claude.loggedIn), brainIsCC = choice.brainProvider === 'claude-code';
  $('worker-field').hidden = brainIsCC;
  $('worker').disabled = !cc;
  if (!cc) $('worker').value = 'off';
  $('agent-field').hidden = !cc || (!brainIsCC && $('worker').value === 'off');
  $('worker-help').textContent = !cc
    ? 'FRIDAY runs on Claude Code, which is not set up on this Mac. Without her, JARVIS does short jobs itself and tells you when something needs more.'
    : brainIsCC ? 'With Claude Code as the brain, FRIDAY runs as its background agents.'
    : $('worker').value === 'off' ? 'Off: JARVIS does short jobs itself and tells you when something needs more.'
    : 'FRIDAY uses your Claude plan. JARVIS still asks you before anything that sends, posts, deletes or pays.';
}

// ---------- Ollama, done for the user ----------

const hasModel = (m) => !!m && ol.models.some((x) => x === m || x.startsWith(m + ':') || m === x.replace(/:latest$/, ''));

function renderOllama() {
  const text = $('ol-text'), btn = $('ol-action');
  $('ol-actions').hidden = ol.running || !!olBusy && olBusy !== 'install' && olBusy !== 'start';
  btn.disabled = !!olBusy;
  if (!ol.installed) {
    text.textContent = 'Ollama is not on this Mac yet. JARVIS can download it from ollama.com and set it up for you.';
    btn.textContent = olBusy === 'install' ? 'Installing…' : 'Install Ollama';
  } else if (!ol.running) {
    text.textContent = 'Ollama is installed but not running.';
    btn.textContent = olBusy === 'start' ? 'Starting…' : 'Start Ollama';
  } else {
    text.textContent = ol.models.length ? 'Ollama is running. Choose the model JARVIS should think with.' : 'Ollama is running. Download a model to think with; it only downloads once.';
  }
  // Installed models first, then recommended ones that aren't here yet.
  const rows = [];
  if (ol.running) {
    for (const m of ol.models) {
      const rec = ol.recommended.find((r) => m === r.id || m.startsWith(r.id + ':'));
      rows.push({ id: m.replace(/:latest$/, ''), name: rec ? rec.name : m, note: rec ? rec.note : 'Installed', installed: true });
    }
    for (const r of ol.recommended) if (!hasModel(r.id)) rows.push({ ...r, installed: false });
  }
  const cur = $('ollamaModel').value;
  if (ol.running && !hasModel(cur)) { const first = rows.find((r) => r.installed); $('ollamaModel').value = first ? first.id : ''; }
  const ul = $('ol-models');
  ul.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = r.installed ? 'ready' : '';
    li.classList.toggle('on', r.installed && hasModel($('ollamaModel').value) && (r.id === $('ollamaModel').value || r.id === $('ollamaModel').value.replace(/:latest$/, '')));
    li.innerHTML = '<span class="dot"></span><div><b></b><small></small></div><em></em>';
    li.querySelector('b').textContent = r.name;
    li.querySelector('small').textContent = r.note + (r.size && !r.installed ? ` · ${r.size}` : '');
    const em = li.querySelector('em');
    if (r.installed) { em.textContent = 'Ready'; li.addEventListener('click', () => { $('ollamaModel').value = r.id; renderOllama(); updateNext(); }); }
    else {
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = olBusy === r.id ? 'Downloading…' : 'Download'; b.disabled = !!olBusy;
      b.addEventListener('click', () => ollamaDo('pull', r.id));
      em.appendChild(b);
    }
    ul.appendChild(li);
  }
  const chip = $('ollama-status');
  if (!ol.installed) status(chip, '— not installed', '');
  else if (!ol.running) status(chip, '! installed · not running', 'warn');
  else if (!ol.models.length) status(chip, '! running · no models yet', 'warn');
  else status(chip, `✓ ready · ${ol.models.length} model${ol.models.length === 1 ? '' : 's'}`, 'ok');
}

async function refreshOllama() {
  ol = await window.setup.ollama('state', { url: $('ollamaUrl').value.trim() });
  info.found.ollama = { running: ol.running, models: ol.models };
  renderOllama();
  updateNext();
}

async function ollamaDo(action, model) {
  olBusy = action === 'pull' ? model : action;
  $('ol-bar').hidden = action === 'start';
  setBar(0, action === 'install' ? 'Downloading Ollama' : `Downloading ${model}`);
  renderOllama(); updateNext();
  const r = await window.setup.ollama(action, { url: $('ollamaUrl').value.trim(), model });
  olBusy = '';
  $('ol-bar').hidden = true;
  if (action === 'pull' && r.ok) $('ollamaModel').value = model;
  await refreshOllama();
  if (!r.ok) status($('brain-msg'), r.msg || 'That did not work.', 'bad');
}

function setBar(pct, phase) {
  $('ol-bar').querySelector('i').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('ol-phase').textContent = pct ? `${phase} · ${pct}%` : phase;
}

function select(group, attr, value) {
  choice[group] = value;
  document.querySelectorAll(`[data-${attr}]`).forEach((c) => c.classList.toggle('on', c.dataset[attr] === value));
  if (attr === 'brain') {
    document.querySelectorAll('[data-for]').forEach((g) => g.classList.toggle('show', g.dataset.for === value));
    if (info) { renderWorker(); updateNext(); }
  } else if (attr === 'stt') {
    document.querySelectorAll('[data-for-stt]').forEach((g) => g.classList.toggle('show', g.dataset.forStt === value));
  } else if (attr === 'tts') {
    document.querySelectorAll('[data-for-tts]').forEach((g) => g.classList.toggle('show', g.dataset.forTts === value));
  }
}

function pickTheme(theme, mode) {
  if (theme) choice.theme = theme;
  if (mode) choice.themeMode = mode;
  const r = window.jarvisTheme.apply(choice.theme, choice.themeMode);
  document.querySelectorAll('[data-theme-pick]').forEach((t) => {
    t.classList.toggle('on', t.dataset.themePick === choice.theme);
    const pv = t.querySelector('.pv');
    pv.dataset.theme = t.dataset.themePick;
    pv.dataset.mode = r.mode;
  });
  document.querySelectorAll('[data-mode-pick]').forEach((b) => b.classList.toggle('on', b.dataset.modePick === choice.themeMode));
}

function autoPick() {
  const f = info.found;
  const hasKey = $('anthropicApiKey').value || info.cfg.has_anthropicApiKey;
  if (f.claude.path && f.claude.loggedIn) return 'Claude Code';
  if (hasKey) return 'Anthropic API';
  if ($('geminiApiKey').value || info.cfg.has_geminiApiKey) return 'Gemini';
  return 'Ollama';
}

function renderDetection() {
  const f = info.found;
  const cc = $('cc-status');
  if (!f.claude.path) { status(cc, '— not installed', ''); $('cc-help').innerHTML = 'Claude Code is not installed. To use it, run <code>npm install -g @anthropic-ai/claude-code</code> in Terminal, then <code>claude</code> once to sign in, and reopen Setup.'; }
  else if (!f.claude.loggedIn) { status(cc, '! not signed in', 'warn'); $('cc-help').innerHTML = 'Run <code>claude</code> in Terminal once and sign in, then reopen Setup.'; }
  else { status(cc, `✓ ready · ${f.claude.version.replace(/\s*\(Claude Code\)/i, '')}`, 'ok'); $('cc-help').textContent = 'Runs without permission prompts and hands long tasks to background agents. It asks before anything that sends, posts, deletes or pays.'; }
  $('cc-fields').hidden = !(f.claude.path && f.claude.loggedIn);
  status($('api-status'), info.cfg.has_anthropicApiKey ? '✓ key stored' : '— no key', info.cfg.has_anthropicApiKey ? 'ok' : '');
  status($('gemini-status'), info.cfg.has_geminiApiKey ? '✓ key stored' : '— no key', info.cfg.has_geminiApiKey ? 'ok' : '');
  const i = info.installed;
  status($('kokoro-status'), i.kokoro ? '✓ installed' : '! run ./setup.sh', i.kokoro ? 'ok' : 'warn');
  $('kokoro-help').innerHTML = i.kokoro ? '' : 'Kokoro needs Python and a 330 MB model. Run <code>./setup.sh</code> in the JARVIS folder, or pick another voice.';
  status($('edge-status'), i.edge ? '✓ installed' : '! run ./setup.sh', i.edge ? 'ok' : 'warn');
  status($('hooks-status'), i.hooks ? '✓ installed' : '', 'ok');
  if (i.hooks) $('install-hooks').textContent = 'Reinstall hooks';
  $('iterm-note').textContent = i.iterm ? '' : 'Session control drives iTerm2. Install it from iterm2.com to use it.';
  const nv = $('nativeVoice');
  nv.innerHTML = '';
  for (const v of info.sayVoices.length ? info.sayVoices : ['Daniel', 'Samantha']) nv.add(new Option(v, v));
}

function fillList(id, items) { $(id).innerHTML = items.map((m) => `<option value="${m.replace(/"/g, '&quot;')}">`).join(''); }

function load() {
  const c = info.cfg;
  for (const k of [...TEXT, ...NUM]) if ($(k) && c[k] !== undefined && c[k] !== null) $(k).value = c[k] || (k === 'telegramChatId' ? '' : c[k]);
  for (const k of BOOL) $(k).checked = !!c[k];
  for (const k of SECRET) {
    const stored = c[`has_${k}`] ? '✓ stored — leave empty to keep' : '';
    $(`${k}-stored`).textContent = stored;
    if (k === 'elevenLabsApiKey') $('elevenLabsApiKey-stored2').textContent = stored;
  }
  // Saved "Daniel" matches "Daniel (English (UK))"; otherwise prefer a British voice.
  const nv = $('nativeVoice');
  const opts = [...nv.options].map((o) => o.value);
  nv.value = opts.find((v) => v === c.nativeVoice) || opts.find((v) => v.startsWith(c.nativeVoice || 'Daniel')) || opts.find((v) => /UK/.test(v)) || opts[0] || '';
  select('brainProvider', 'brain', !c.brainProvider || c.brainProvider === 'auto' ? bestBrain() : c.brainProvider);
  select('sttEngine', 'stt', c.sttEngine === 'elevenlabs' ? 'elevenlabs' : 'apple');
  select('ttsEngine', 'tts', c.ttsEngine || 'kokoro');
  pickTheme(c.theme || 'jarvis', c.themeMode || 'dark');
}

function gather() {
  const p = { ...choice };
  for (const k of TEXT) if ($(k)) p[k] = $(k).value.trim();
  for (const k of NUM) { const v = parseFloat($(k).value); p[k] = isNaN(v) ? (k === 'telegramChatId' ? 0 : undefined) : v; if (p[k] === undefined) delete p[k]; }
  for (const k of BOOL) p[k] = $(k).checked;
  p.anthropicApiKey = $('anthropicApiKey').value.trim();
  p.geminiApiKey = $('geminiApiKey').value.trim();
  p.elevenLabsApiKey = ($('elevenLabsApiKey').value || $('elevenLabsApiKey2').value).trim();
  p.telegramToken = $('telegramToken').value.trim();
  if (!p.honorific) p.honorific = 'sir';
  return p;
}

function renderSummary() {
  const p = gather();
  const brain = { auto: `Automatic (${autoPick()})`, 'claude-code': `Claude Code · ${p.model}`, anthropic: `Anthropic API · ${p.anthropicModel}`, gemini: `Gemini · ${p.geminiModel}`, ollama: `Ollama · ${p.ollamaModel}` }[p.brainProvider];
  const cc = info.found.claude.path && info.found.claude.loggedIn;
  const worker = !cc ? 'off' : p.brainProvider === 'claude-code' ? `background agents · ${p.agentModel}` : p.worker === 'off' ? 'off' : `FRIDAY on Claude Code · ${p.agentModel}`;
  const rows = [
    ['Name', p.userName ? `${p.userName} (“${p.honorific}”)` : `“${p.honorific}”`],
    ['Look', `${choice.theme[0].toUpperCase() + choice.theme.slice(1)} · ${choice.themeMode === 'system' ? 'match macOS' : choice.themeMode}`],
    ['Brain', brain],
    ['Worker', worker],
    ['Listening', p.sttEngine === 'elevenlabs' ? 'ElevenLabs Scribe (awake), on-device (asleep)' : 'On-device (Apple)'],
    ['Voice', { kokoro: `Kokoro · ${p.kokoroVoice}`, elevenlabs: 'ElevenLabs', edge: `Edge · ${p.edgeVoice}`, native: `macOS · ${p.nativeVoice}` }[p.ttsEngine]],
    ['Telegram', p.telegramToken || info.cfg.has_telegramToken ? 'configured' : 'off'],
  ];
  $('summary').innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><b></b></li>`).join('');
  [...$('summary').querySelectorAll('b')].forEach((el, i) => { el.textContent = rows[i][1]; });
}

/** Problems that would stop the chosen setup from working. */
function problem() {
  const p = gather();
  const f = info.found;
  const why = brainProblem();
  if (why) return why;
  if (p.brainProvider === 'claude-code' && !f.claude.path) return 'Claude Code is not installed. Pick another brain or install it.';
  if (p.brainProvider === 'anthropic' && !p.anthropicApiKey && !info.cfg.has_anthropicApiKey) return 'Enter an Anthropic API key.';
  if (p.brainProvider === 'gemini' && !p.geminiApiKey && !info.cfg.has_geminiApiKey) return 'Enter a Gemini API key.';
  const needs11 = p.sttEngine === 'elevenlabs' || p.ttsEngine === 'elevenlabs';
  if (needs11 && !p.elevenLabsApiKey && !info.cfg.has_elevenLabsApiKey) return 'Enter an ElevenLabs API key.';
  if (p.brainProvider === 'auto' && !(f.claude.path && f.claude.loggedIn) && !p.anthropicApiKey && !info.cfg.has_anthropicApiKey && !p.geminiApiKey && !info.cfg.has_geminiApiKey && !f.ollama.running) {
    return 'No brain is available yet: install Claude Code, add an API key, or start Ollama.';
  }
  return null;
}

/** Save, and treat any secret just typed as stored from now on. */
async function saveAndRemember() {
  const p = gather();
  await window.setup.save(p);
  for (const k of SECRET) if (p[k]) info.cfg[`has_${k}`] = true;
}

async function next() {
  if (STEPS[step] === 'finish') {
    const err = problem();
    if (err) { status($('saved'), err, 'bad'); return; }
    await saveAndRemember();
    status($('saved'), FIRST ? 'Starting…' : 'Saved. Restarting…', 'ok');
    await window.setup.finish();
    return;
  }
  await saveAndRemember();
  show(step + 1);
}

async function test(kind) {
  const map = {
    anthropic: ['anthropicApiKey', 'api-status'], gemini: ['geminiApiKey', 'gemini-status'], ollama: ['ollamaUrl', 'ollama-status'],
    elevenlabs: ['elevenLabsApiKey', 'el-status'], elevenlabs2: ['elevenLabsApiKey2', 'el2-status'], telegram: ['telegramToken', 'tg-status'],
  };
  const [field, statusId] = map[kind];
  const out = $(statusId);
  status(out, 'testing…');
  const r = await window.setup.test(kind === 'elevenlabs2' ? 'elevenlabs' : kind, $(field).value.trim());
  if (kind === 'anthropic' || kind === 'gemini') tested[kind] = !!r.ok;
  if (kind === 'ollama') { await refreshOllama(); if (!r.ok) status(out, '✗ not reachable', 'bad'); return; }
  if (!r.ok) { status(out, `✗ ${r.msg || 'failed'}`, 'bad'); updateNext(); return; }
  if (kind === 'anthropic') { status(out, '✓ key works', 'ok'); fillList('anthropic-models', r.models || []); }
  else if (kind === 'gemini') { status(out, '✓ key works', 'ok'); fillList('gemini-models', ['gemini-flash-latest', ...(r.models || [])]); }
  else if (kind === 'telegram') status(out, `✓ ${r.msg}`, 'ok');
  else {
    status(out, `✓ ${r.voices.length} voices`, 'ok');
    const sel = $('elevenLabsVoiceId');
    const keep = sel.value;
    sel.innerHTML = '';
    for (const v of r.voices) sel.add(new Option(v.name, v.id));
    sel.value = r.voices.some((v) => v.id === keep) ? keep : (r.voices[0] || {}).id;
  }
  updateNext();
}

function bind() {
  document.querySelectorAll('[data-brain]').forEach((c) => c.addEventListener('click', () => { select('brainProvider', 'brain', c.dataset.brain); }));
  document.querySelectorAll('[data-stt]').forEach((c) => c.addEventListener('click', () => select('sttEngine', 'stt', c.dataset.stt)));
  document.querySelectorAll('[data-tts]').forEach((c) => c.addEventListener('click', () => { select('ttsEngine', 'tts', c.dataset.tts); status($('voice-result'), ''); }));
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => test(b.dataset.test)));
  document.querySelectorAll('[data-theme-pick]').forEach((t) => t.addEventListener('click', () => { pickTheme(t.dataset.themePick); window.setup.save({ theme: choice.theme }); }));
  document.querySelectorAll('[data-mode-pick]').forEach((b) => b.addEventListener('click', () => { pickTheme(null, b.dataset.modePick); window.setup.save({ themeMode: choice.themeMode }); }));
  // Picked in the HUD while this window is open.
  window.setup.onTheme((t) => pickTheme(t.theme, t.mode));
  window.jarvisTheme.onChange(() => document.querySelectorAll('.pv').forEach((pv) => { pv.dataset.mode = window.jarvisTheme.current().mode; }));
  document.querySelectorAll('#steps li').forEach((li, i) => li.addEventListener('click', async () => { if (!FIRST || i <= furthest) { await saveAndRemember(); show(i); } }));
  document.querySelectorAll('a[data-href]').forEach((a) => a.addEventListener('click', () => window.setup.open(a.dataset.href)));
  // One ElevenLabs key, two fields.
  $('elevenLabsApiKey').addEventListener('input', () => { $('elevenLabsApiKey2').value = $('elevenLabsApiKey').value; });
  $('elevenLabsApiKey2').addEventListener('input', () => { $('elevenLabsApiKey').value = $('elevenLabsApiKey2').value; });
  for (const [k, kind] of [['anthropicApiKey', 'anthropic'], ['geminiApiKey', 'gemini']]) $(k).addEventListener('input', () => { delete tested[kind]; updateNext(); });
  $('ol-action').addEventListener('click', () => ollamaDo(ol.installed ? 'start' : 'install'));
  $('worker').addEventListener('change', renderWorker);
  document.querySelectorAll('#perms li').forEach((li) => li.querySelector('button').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true; b.textContent = 'Asking…';
    if (li.dataset.perm === 'notifications') notified = true;
    perms = (await window.setup.permissions('ask', li.dataset.perm)) || perms;
    b.disabled = false;
    renderPerms();
  }));
  // Back from System Settings: show what changed.
  window.addEventListener('focus', () => { if (STEPS[step] === 'access') refreshPerms(); });
  window.setup.onOllamaProgress((pr) => setBar(pr.pct, pr.phase));
  $('back').addEventListener('click', () => show(step - 1));
  $('next').addEventListener('click', next);
  $('test-voice').addEventListener('click', async () => {
    status($('voice-result'), 'speaking…');
    const engine = await window.setup.testVoice(gather());
    status($('voice-result'), engine === choice.ttsEngine ? `✓ ${engine}` : `fell back to ${engine}`, engine === choice.ttsEngine ? 'ok' : 'warn');
  });
  $('install-hooks').addEventListener('click', async () => {
    status($('hooks-status'), 'installing…');
    const r = await window.setup.installHooks();
    status($('hooks-status'), r.ok ? '✓ installed' : `✗ ${r.msg}`, r.ok ? 'ok' : 'bad');
  });
}

(async () => {
  info = await window.setup.get();
  renderDetection();
  load();
  bind();
  await refreshOllama();
  show(0);
})();
