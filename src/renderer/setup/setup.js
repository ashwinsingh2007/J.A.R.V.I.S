// Setup / onboarding wizard. Reads detection results from the main process,
// lets the user choose brain, ears and voice, saves to ~/.jarvis/config.json.
const $ = (id) => document.getElementById(id);
const FIRST = new URLSearchParams(location.search).get('first') === '1';
const STEPS = ['welcome', 'look', 'brain', 'ears', 'voice', 'extras', 'finish'];
const TEXT = ['userName', 'honorific', 'model', 'effort', 'anthropicModel', 'ollamaUrl', 'ollamaModel', 'speechLocale', 'appleSpeech', 'kokoroVoice', 'elevenLabsVoiceId', 'elevenLabsModel', 'edgeVoice', 'nativeVoice', 'radioCountry'];
const NUM = ['commandSilenceSeconds', 'kokoroSpeed', 'telegramChatId'];
const BOOL = ['requireEndWord', 'telegramVoiceReplies'];
const SECRET = ['anthropicApiKey', 'elevenLabsApiKey', 'telegramToken'];

let info = null;
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
}

function select(group, attr, value) {
  choice[group] = value;
  document.querySelectorAll(`[data-${attr}]`).forEach((c) => c.classList.toggle('on', c.dataset[attr] === value));
  if (attr === 'brain') {
    document.querySelectorAll('[data-for]').forEach((g) => g.classList.toggle('show', value === 'auto' || g.dataset.for === value));
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
  return 'Ollama';
}

function renderDetection() {
  const f = info.found;
  const cc = $('cc-status');
  if (!f.claude.path) { status(cc, '✗ not installed', 'bad'); $('cc-help').innerHTML = 'Install: <code>npm install -g @anthropic-ai/claude-code</code>, then run <code>claude</code> once to sign in.'; }
  else if (!f.claude.loggedIn) { status(cc, `! ${f.claude.version} · not signed in`, 'warn'); $('cc-help').innerHTML = 'Run <code>claude</code> in Terminal once and sign in.'; }
  else { status(cc, `✓ ${f.claude.version}`, 'ok'); $('cc-help').textContent = 'Runs without permission prompts and hands long tasks to background agents. It asks before anything that sends, posts, deletes or pays.'; }
  status($('api-status'), info.cfg.has_anthropicApiKey ? '✓ key stored' : '— no key', info.cfg.has_anthropicApiKey ? 'ok' : '');
  status($('ollama-status'), f.ollama.running ? `✓ running · ${f.ollama.models.length} models` : '— not running', f.ollama.running ? 'ok' : '');
  fillList('ollama-models', f.ollama.models);
  status($('auto-pick'), `→ ${autoPick()}`, 'ok');
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
  select('brainProvider', 'brain', c.brainProvider || 'auto');
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
  p.elevenLabsApiKey = ($('elevenLabsApiKey').value || $('elevenLabsApiKey2').value).trim();
  p.telegramToken = $('telegramToken').value.trim();
  if (!p.honorific) p.honorific = 'sir';
  return p;
}

function renderSummary() {
  const p = gather();
  const brain = { auto: `Automatic (${autoPick()})`, 'claude-code': `Claude Code · ${p.model}`, anthropic: `Anthropic API · ${p.anthropicModel}`, ollama: `Ollama · ${p.ollamaModel}` }[p.brainProvider];
  const rows = [
    ['Name', p.userName ? `${p.userName} (“${p.honorific}”)` : `“${p.honorific}”`],
    ['Look', `${choice.theme[0].toUpperCase() + choice.theme.slice(1)} · ${choice.themeMode === 'system' ? 'match macOS' : choice.themeMode}`],
    ['Brain', brain],
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
  if (p.brainProvider === 'claude-code' && !f.claude.path) return 'Claude Code is not installed. Pick another brain or install it.';
  if (p.brainProvider === 'anthropic' && !p.anthropicApiKey && !info.cfg.has_anthropicApiKey) return 'Enter an Anthropic API key.';
  const needs11 = p.sttEngine === 'elevenlabs' || p.ttsEngine === 'elevenlabs';
  if (needs11 && !p.elevenLabsApiKey && !info.cfg.has_elevenLabsApiKey) return 'Enter an ElevenLabs API key.';
  if (p.brainProvider === 'auto' && !(f.claude.path && f.claude.loggedIn) && !p.anthropicApiKey && !info.cfg.has_anthropicApiKey && !f.ollama.running) {
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
    anthropic: ['anthropicApiKey', 'api-status'], ollama: ['ollamaUrl', 'ollama-status'],
    elevenlabs: ['elevenLabsApiKey', 'el-status'], elevenlabs2: ['elevenLabsApiKey2', 'el2-status'], telegram: ['telegramToken', 'tg-status'],
  };
  const [field, statusId] = map[kind];
  const out = $(statusId);
  status(out, 'testing…');
  const r = await window.setup.test(kind === 'elevenlabs2' ? 'elevenlabs' : kind, $(field).value.trim());
  if (!r.ok) { status(out, `✗ ${r.msg || 'failed'}`, 'bad'); return; }
  if (kind === 'anthropic') { status(out, '✓ key works', 'ok'); fillList('anthropic-models', r.models || []); }
  else if (kind === 'ollama') { status(out, `✓ running · ${r.models.length} models`, 'ok'); fillList('ollama-models', r.models); info.found.ollama = { running: true, models: r.models }; }
  else if (kind === 'telegram') status(out, `✓ ${r.msg}`, 'ok');
  else {
    status(out, `✓ ${r.voices.length} voices`, 'ok');
    const sel = $('elevenLabsVoiceId');
    const keep = sel.value;
    sel.innerHTML = '';
    for (const v of r.voices) sel.add(new Option(v.name, v.id));
    sel.value = r.voices.some((v) => v.id === keep) ? keep : (r.voices[0] || {}).id;
  }
  status($('auto-pick'), `→ ${autoPick()}`, 'ok');
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
  $('anthropicApiKey').addEventListener('input', () => status($('auto-pick'), `→ ${autoPick()}`, 'ok'));
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
  show(0);
})();
