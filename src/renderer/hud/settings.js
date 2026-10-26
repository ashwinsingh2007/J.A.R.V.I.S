/* Settings pages inside the HUD's Settings box. Each card on the Settings tab opens its page in the
   same box, with BACK returning to the cards. The pages do what Setup does (detect, install and start
   Ollama, download models, test keys, permissions, the worker), through cfg:* actions to main, which
   answers with cfg-* events. Rows marked data-key save live through hud.js as before. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const post = (msg) => { try { window.webkit.messageHandlers.jarvis.postMessage(msg); } catch (e) { /* demo */ } };
  const ask = (name, extra = {}) => post({ type: 'action', name, ...extra });
  const TITLES = { brain: 'BRAIN & WORKER', access: 'ACCESS', ears: 'LISTENING', voice: 'VOICE', extras: 'TELEGRAM & EXTRAS' };

  let info = null;           // setupInfo() from main: cfg (secrets as has_*), found, installed, brain, workerAvailable
  let page = '';
  let choice = '';           // the brain picked on the Brain page
  let ol = { installed: false, running: false, models: [], recommended: [] };
  let olBusy = '';
  const tested = {};         // anthropic / gemini / telegram: the typed key passed Test
  let perms = {};
  let notified = false;

  function chip(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
  }
  function msg(id, text, cls) { const el = $(id); if (el) { el.textContent = text || ''; el.className = 'sp-msg' + (cls ? ' ' + cls : ''); } }

  // ---------- pages ----------

  function open(section) {
    if (!TITLES[section]) { home(); return; }
    page = section;
    $('set-home').hidden = true;
    $('set-page').hidden = false;
    $('set-hint').hidden = true;
    $('sp-title').textContent = TITLES[section];
    document.querySelectorAll('#set-page .sp').forEach((p) => { p.hidden = p.dataset.page !== section; });
    document.querySelector('.panel.settings').scrollTop = 0;
    if (section === 'brain') { choice = ''; olModel = ''; msg('b-msg', ''); $('b-restart').hidden = true; }   // start from what is saved
    ask('cfg:info');
    if (section === 'access') ask('cfg:perms', { op: 'state' });
    if (section === 'brain') ask('cfg:ollama', { action: 'state', url: $('b-ol-url').value.trim() || undefined });
    syncRows();
  }

  function home() {
    page = '';
    $('set-page').hidden = true;
    $('set-home').hidden = false;
    $('set-hint').hidden = false;
  }

  // Engine-specific rows on the Listening and Voice pages.
  function syncRows() {
    const stt = document.querySelector('[data-key="sttEngine"]');
    document.querySelectorAll('li[data-stt]').forEach((li) => { li.hidden = !stt || stt.value !== li.dataset.stt; });
  }

  // ---------- brain & worker ----------

  const ccReady = () => !!(info && info.found.claude.path && info.found.claude.loggedIn);
  const hasModel = (m) => !!m && ol.models.some((x) => x === m || x.startsWith(m + ':') || m === x.replace(/:latest$/, ''));

  function bestBrain() {
    const c = info.cfg;
    if (c.brainProvider && c.brainProvider !== 'auto') return c.brainProvider;
    if (ccReady()) return 'claude-code';
    if (c.has_anthropicApiKey) return 'anthropic';
    if (c.has_geminiApiKey) return 'gemini';
    return 'ollama';
  }

  function loadBrain() {
    const c = info.cfg;
    if (!choice) choice = bestBrain();
    $('b-model').value = c.model || 'sonnet';
    $('b-effort').value = c.effort || 'low';
    $('b-gemini-model').value = c.geminiModel || 'gemini-flash-latest';
    $('b-anthropic-model').value = c.anthropicModel || '';
    if (!$('b-ol-url').value) $('b-ol-url').value = c.ollamaUrl || 'http://127.0.0.1:11434';
    $('b-worker').value = c.worker || 'claude-code';
    $('b-agent').value = ['opus', 'sonnet', 'haiku'].includes(c.agentModel) ? c.agentModel : 'opus';
    for (const [k, id] of [['geminiApiKey', 'b-gemini-key'], ['anthropicApiKey', 'b-anthropic-key']]) $(id).placeholder = c[`has_${k}`] ? 'stored — leave empty to keep' : id.includes('gemini') ? 'AIza…' : 'sk-ant-…';
    renderBrain();
  }

  function brainProblem() {
    if (!info) return 'Loading…';
    if (choice === 'claude-code') {
      if (!info.found.claude.path) return 'Claude Code is not installed on this Mac.';
      if (!info.found.claude.loggedIn) return 'Claude Code needs you to sign in once: run claude in Terminal.';
      return null;
    }
    if (choice === 'ollama') {
      if (olBusy) return 'Working on it…';
      if (!ol.installed) return 'Install Ollama to use it.';
      if (!ol.running) return 'Start Ollama to use it.';
      if (!hasModel(selectedModel())) return 'Download a model to use it.';
      return null;
    }
    const key = choice === 'gemini' ? 'geminiApiKey' : 'anthropicApiKey';
    const typed = $(choice === 'gemini' ? 'b-gemini-key' : 'b-anthropic-key').value.trim();
    if (!typed && !info.cfg[`has_${key}`]) return `Paste your ${choice === 'gemini' ? 'Gemini' : 'Anthropic'} API key, then press TEST.`;
    if (typed && tested[choice] === false) return 'That key was rejected.';
    if (typed && !tested[choice]) return 'Press TEST to check the key.';
    return null;
  }

  let olModel = '';
  const selectedModel = () => olModel || (info && info.cfg.ollamaModel) || '';

  function renderBrain() {
    if (!info) return;
    const f = info.found;
    document.querySelectorAll('.bcard').forEach((b) => b.classList.toggle('on', b.dataset.b === choice));
    document.querySelectorAll('.bpanel').forEach((p) => { p.hidden = p.dataset.for !== choice; });
    // card chips
    chip($('bc-claude-code'), !f.claude.path ? 'NOT INSTALLED' : !f.claude.loggedIn ? 'SIGN IN NEEDED' : 'READY', ccReady() ? 'ok' : f.claude.path ? 'warn' : '');
    chip($('bc-ollama'), !ol.installed ? 'NOT INSTALLED' : !ol.running ? 'NOT RUNNING' : ol.models.length ? `READY · ${ol.models.length} MODEL${ol.models.length === 1 ? '' : 'S'}` : 'NO MODEL YET', ol.running && ol.models.length ? 'ok' : ol.installed ? 'warn' : '');
    chip($('bc-gemini'), info.cfg.has_geminiApiKey ? 'KEY STORED' : 'NO KEY', info.cfg.has_geminiApiKey ? 'ok' : '');
    chip($('bc-anthropic'), info.cfg.has_anthropicApiKey ? 'KEY STORED' : 'NO KEY', info.cfg.has_anthropicApiKey ? 'ok' : '');
    // Claude Code
    $('b-cc-note').textContent = !f.claude.path ? 'Claude Code is not installed. In Terminal: npm install -g @anthropic-ai/claude-code, then claude once to sign in.'
      : !f.claude.loggedIn ? 'Run claude in Terminal once and sign in.' : `Claude Code ${String(f.claude.version || '').replace(/\s*\(Claude Code\)/i, '')} is ready. It asks before anything that sends, posts, deletes or pays.`;
    $('b-cc-fields').hidden = !ccReady();
    renderOllama();
    // worker
    const brainIsCC = choice === 'claude-code';
    $('b-worker-row').hidden = brainIsCC;
    $('b-worker').disabled = !ccReady();
    if (!ccReady()) $('b-worker').value = 'off';
    $('b-agent-row').hidden = !ccReady() || (!brainIsCC && $('b-worker').value === 'off');
    $('b-worker-note').textContent = !ccReady() ? 'The background worker runs on Claude Code, which is not set up here. Without it, JARVIS does short jobs itself.'
      : brainIsCC ? 'With Claude Code as the brain, the worker runs as its background agent.'
      : $('b-worker').value === 'off' ? 'Off: JARVIS does short jobs itself and tells you when something needs more.' : 'The worker uses your Claude plan.';
    const why = brainProblem();
    $('b-save').disabled = !!why;
    if (why) msg('b-msg', why, ''); else if (!/Saved|Restart/.test($('b-msg').textContent)) msg('b-msg', '');
  }

  function renderOllama() {
    const btn = $('b-ol-action');
    const text = !ol.installed ? 'Ollama is not on this Mac yet. JARVIS can download it from ollama.com and set it up.'
      : !ol.running ? 'Ollama is installed but not running.'
      : ol.models.length ? 'Ollama is running. Choose the model JARVIS thinks with.' : 'Ollama is running. Download a model; it only downloads once.';
    $('b-ol-text').textContent = text;
    btn.hidden = ol.running;
    btn.disabled = !!olBusy;
    btn.textContent = !ol.installed ? (olBusy === 'install' ? 'INSTALLING…' : 'INSTALL OLLAMA') : (olBusy === 'start' ? 'STARTING…' : 'START OLLAMA');
    const rows = [];
    if (ol.running) {
      for (const m of ol.models) {
        const rec = ol.recommended.find((r) => m === r.id || m.startsWith(r.id + ':'));
        rows.push({ id: m.replace(/:latest$/, ''), name: rec ? rec.name : m, note: rec ? rec.note : 'Installed', installed: true });
      }
      for (const r of ol.recommended) if (!hasModel(r.id)) rows.push({ ...r, installed: false });
    }
    if (ol.running && !hasModel(selectedModel())) { const first = rows.find((r) => r.installed); olModel = first ? first.id : ''; }
    const ul = $('b-ol-models');
    ul.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = (r.installed ? 'ready' : '') + (r.installed && (r.id === selectedModel() || r.id === selectedModel().replace(/:latest$/, '')) ? ' on' : '');
      li.innerHTML = '<span class="dot"></span><div><b></b><small></small></div><em></em>';
      li.querySelector('b').textContent = r.name.toUpperCase();
      li.querySelector('small').textContent = r.note + (r.size && !r.installed ? ` · ${r.size}` : '');
      const em = li.querySelector('em');
      if (r.installed) { em.textContent = 'READY'; li.addEventListener('click', () => { olModel = r.id; renderBrain(); }); }
      else {
        const b = document.createElement('button');
        b.className = 'mini'; b.textContent = olBusy === r.id ? 'DOWNLOADING…' : 'DOWNLOAD'; b.disabled = !!olBusy;
        b.addEventListener('click', () => ollamaDo('pull', r.id));
        em.appendChild(b);
      }
      ul.appendChild(li);
    }
  }

  function ollamaDo(action, model) {
    olBusy = action === 'pull' ? model : action;
    $('b-ol-bar').hidden = action === 'start';
    setBar(0, action === 'install' ? 'Downloading Ollama' : `Downloading ${model}`);
    renderBrain();
    ask('cfg:ollama', { action, model, url: $('b-ol-url').value.trim() || undefined });
  }

  function setBar(pct, phase) {
    $('b-ol-bar').querySelector('i').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $('b-ol-phase').textContent = pct ? `${phase} · ${pct}%` : phase;
  }

  function saveBrain() {
    const patch = { brainProvider: choice, model: $('b-model').value, effort: $('b-effort').value, worker: $('b-worker').value, agentModel: $('b-agent').value,
      ollamaUrl: $('b-ol-url').value.trim(), geminiModel: $('b-gemini-model').value.trim(), anthropicModel: $('b-anthropic-model').value.trim(),
      geminiApiKey: $('b-gemini-key').value.trim(), anthropicApiKey: $('b-anthropic-key').value.trim() };
    if (choice === 'ollama' && selectedModel()) patch.ollamaModel = selectedModel();
    msg('b-msg', 'Saving…');
    lastSave = 'b';
    ask('cfg:save', { patch });
  }

  // ---------- access ----------

  const PERM = { allowed: ['ALLOWED', 'ok'], 'not-asked': ['NOT YET', 'warn'], denied: ['NOT ALLOWED', 'bad'], unknown: ['—', ''], absent: ['NOT INSTALLED', ''] };
  function renderPerms() {
    document.querySelectorAll('#hud-perms li').forEach((li) => {
      const k = li.dataset.perm;
      const st = k === 'notifications' ? (notified ? 'allowed' : 'not-asked') : perms[k] || 'unknown';
      const [label, cls] = k === 'notifications' && notified ? ['TEST SENT', 'ok'] : PERM[st] || PERM.unknown;
      chip(li.querySelector('.chip'), label, cls);
      const b = li.querySelector('button');
      b.hidden = st === 'allowed' || st === 'absent';
      b.disabled = false;
      b.textContent = st === 'denied' ? 'OPEN SETTINGS' : k === 'notifications' ? 'SEND A TEST' : 'ALLOW';
    });
  }

  // ---------- telegram & extras ----------

  function loadExtras() {
    const c = info.cfg;
    $('x-tg-token').placeholder = c.has_telegramToken ? 'stored — leave empty to keep' : '123456:ABC…';
    $('x-tg-chat').value = c.telegramChatId || '';
    $('x-tg-voice').checked = !!c.telegramVoiceReplies;
    $('x-radio').value = c.radioCountry || 'IN';
    $('x-hooks').textContent = info.installed.hooks ? 'INSTALLED' : 'NOT INSTALLED';
    $('x-hooks-btn').textContent = info.installed.hooks ? 'REINSTALL' : 'INSTALL';
  }

  function saveExtras() {
    const patch = { telegramToken: $('x-tg-token').value.trim(), telegramChatId: Number($('x-tg-chat').value) || 0, telegramVoiceReplies: $('x-tg-voice').checked, radioCountry: $('x-radio').value };
    msg('x-msg', 'Saving…');
    lastSave = 'x';
    ask('cfg:save', { patch });
  }

  // ---------- events from main ----------

  let lastSave = '';
  function event(e) {
    switch (e.type) {
      case 'cfg-info':
        info = e;
        if (page === 'brain') loadBrain();
        if (page === 'extras') loadExtras();
        break;
      case 'cfg-ollama':
        if (e.action !== 'state' && e.action !== undefined) {
          olBusy = '';
          $('b-ol-bar').hidden = true;
          if (e.action === 'pull' && e.ok) olModel = e.model;
          if (e.ok === false) msg('b-msg', e.msg || 'That did not work.', 'bad');
          ask('cfg:ollama', { action: 'state', url: $('b-ol-url').value.trim() || undefined });
          return;
        }
        ol = e;
        if (info) info.found.ollama = { running: e.running, models: e.models };
        renderBrain();
        break;
      case 'cfg-ollama-progress': setBar(e.pct, e.phase); break;
      case 'cfg-test': {
        const ok = !!e.ok;
        if (e.kind === 'gemini' || e.kind === 'anthropic') {
          tested[e.kind] = ok;
          if (ok && e.models) $(`b-${e.kind}-models`).innerHTML = [...(e.kind === 'gemini' ? ['gemini-flash-latest'] : []), ...e.models].map((m) => `<option value="${String(m).replace(/"/g, '&quot;')}">`).join('');
          msg('b-msg', ok ? 'Key works.' : `Key rejected: ${e.msg || 'failed'}.`, ok ? 'ok' : 'bad');
          renderBrain();
          if (ok) msg('b-msg', 'Key works. Press SAVE to use it.', 'ok');
        } else if (e.kind === 'telegram') msg('x-msg', ok ? `Bot ${e.msg} works.` : `Token rejected: ${e.msg || 'failed'}.`, ok ? 'ok' : 'bad');
        else if (e.kind === 'elevenlabs') { const out = document.querySelector('.sp:not([hidden]) .sp-inline'); if (out) out.remove(); flash(ok ? `ElevenLabs key works · ${(e.voices || []).length} voices.` : `ElevenLabs key rejected: ${e.msg || 'failed'}.`, ok); }
        break;
      }
      case 'cfg-perms': perms = e; renderPerms(); break;
      case 'cfg-hooks': $('x-hooks').textContent = e.ok ? 'INSTALLED' : `FAILED: ${e.msg || ''}`.slice(0, 60); break;
      case 'cfg-saved': {
        if (!lastSave) { ask('cfg:info'); break; }   // a key saved from Listening or Voice
        const id = lastSave;
        $(`${id}-restart`).hidden = !e.restart;
        msg(`${id}-msg`, e.restart ? 'Saved. Restart JARVIS to use it.' : 'Saved and applied.', 'ok');
        ask('cfg:info');
        break;
      }
      case 'cfg-error': msg(page === 'extras' ? 'x-msg' : 'b-msg', e.msg || 'Something went wrong.', 'bad'); break;
      case 'settings': syncRows(); break;
    }
  }

  function flash(text, ok) {
    const p = document.querySelector(`.sp[data-page="${page}"]`);
    if (!p) return;
    const el = document.createElement('p');
    el.className = 'sp-note sp-inline' + (ok ? ' ok' : ' bad');
    el.textContent = text;
    p.appendChild(el);
  }

  // ---------- wiring ----------

  $('sp-back').addEventListener('click', home);
  document.querySelectorAll('#nav a[data-view="settings"]').forEach((a) => a.addEventListener('click', home));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && page && !document.activeElement.matches('input, select, textarea')) { ev.stopPropagation(); home(); } }, true);
  document.querySelectorAll('.bcard').forEach((b) => b.addEventListener('click', () => { choice = b.dataset.b; msg('b-msg', ''); $('b-restart').hidden = true; renderBrain(); }));
  $('b-ol-action').addEventListener('click', () => ollamaDo(ol.installed ? 'start' : 'install'));
  $('b-ol-check').addEventListener('click', () => ask('cfg:ollama', { action: 'state', url: $('b-ol-url').value.trim() }));
  $('b-worker').addEventListener('change', renderBrain);
  for (const [id, kind] of [['b-gemini-key', 'gemini'], ['b-anthropic-key', 'anthropic']]) $(id).addEventListener('input', () => { delete tested[kind]; renderBrain(); });
  document.querySelectorAll('[data-btest]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.btest;
    const field = { gemini: 'b-gemini-key', anthropic: 'b-anthropic-key', telegram: 'x-tg-token' }[kind];
    msg(kind === 'telegram' ? 'x-msg' : 'b-msg', 'Testing…');
    ask('cfg:test', { kind, key: $(field).value.trim() });
  }));
  // ElevenLabs key on the Listening and Voice pages: saved, then tested.
  document.querySelectorAll('[data-ktest]').forEach((b) => b.addEventListener('click', () => {
    const key = $(b.dataset.kfield).value.trim();
    if (key) { lastSave = ''; ask('cfg:save', { patch: { elevenLabsApiKey: key } }); }
    ask('cfg:test', { kind: 'elevenlabs', key });
  }));
  $('b-save').addEventListener('click', saveBrain);
  $('x-save').addEventListener('click', saveExtras);
  for (const id of ['b-restart', 'x-restart']) $(id).addEventListener('click', () => { msg(id.startsWith('b') ? 'b-msg' : 'x-msg', 'Restarting…', 'ok'); ask('cfg:restart'); });
  $('x-hooks-btn').addEventListener('click', () => { $('x-hooks').textContent = 'INSTALLING…'; ask('cfg:hooks'); });
  document.querySelectorAll('#hud-perms li').forEach((li) => li.querySelector('button').addEventListener('click', (ev) => {
    ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'ASKING…';
    if (li.dataset.perm === 'notifications') notified = true;
    ask('cfg:perms', { op: 'ask', which: li.dataset.perm });
  }));
  const stt = document.querySelector('[data-key="sttEngine"]');
  if (stt) stt.addEventListener('change', syncRows);
  // Back from System Settings: refresh what changed.
  window.addEventListener('focus', () => { if (page === 'access') ask('cfg:perms', { op: 'state' }); });

  window.jarvisSettings = { open, home, event };
})();
