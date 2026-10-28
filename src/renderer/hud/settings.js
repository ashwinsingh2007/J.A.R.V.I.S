/* Settings: a sidebar of sections, each shown beside it. The pages do what Setup does (detect, install
   and start Ollama, download models, test keys, permissions), through cfg:* actions to main, which
   answers with cfg-* events. Rows marked data-key save live through hud.js. Which brain, model and voice
   each agent uses is set in the Agents tab (hud.js), not here. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const post = (msg) => { try { window.webkit.messageHandlers.jarvis.postMessage(msg); } catch (e) { /* demo */ } };
  const ask = (name, extra = {}) => post({ type: 'action', name, ...extra });
  const TITLES = { general: 'General', look: 'Appearance', brain: 'Brains & keys', skills: 'Skills', extensions: 'MCP servers', devices: 'Devices', access: 'Access', ears: 'Listening', voice: 'Voice', extras: 'Telegram & extras', system: 'System' };

  let info = null;           // setupInfo() from main: cfg (secrets as has_*), found, installed, brain, workerAvailable
  let page = '';
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
    if (!TITLES[section]) section = 'general';
    page = section;
    $('sp-title').textContent = TITLES[section];
    document.querySelectorAll('#setnav .navitem').forEach((b) => b.classList.toggle('on', b.dataset.section === section));
    document.querySelectorAll('#set-page .sp').forEach((p) => { p.hidden = p.dataset.page !== section; });
    $('set-page').scrollTop = 0;
    if (section === 'brain') { msg('b-msg', ''); $('b-restart').hidden = true; }
    ask('cfg:info');
    if (section === 'access') ask('cfg:perms', { op: 'state' });
    if (section === 'extensions' || section === 'skills') ask('ext:list');
    if (section === 'devices') ask('dev:list');
    if (section === 'brain') ask('cfg:ollama', { action: 'state', url: $('b-ol-url').value.trim() || undefined });
    syncRows();
  }
  const home = () => open(page || 'general');

  // Engine-specific rows on the Listening page.
  function syncRows() {
    const stt = document.querySelector('[data-key="sttEngine"]');
    document.querySelectorAll('li[data-stt]').forEach((li) => { li.hidden = !stt || stt.value !== li.dataset.stt; });
  }

  // ---------- brains & keys ----------

  const ccReady = () => !!(info && info.found.claude.path && info.found.claude.loggedIn);
  const hasModel = (m) => !!m && ol.models.some((x) => x === m || x.startsWith(m + ':') || m === x.replace(/:latest$/, ''));

  function loadBrain() {
    const c = info.cfg;
    if (!$('b-ol-url').value) $('b-ol-url').value = c.ollamaUrl || 'http://127.0.0.1:11434';
    for (const [k, id] of [['geminiApiKey', 'b-gemini-key'], ['anthropicApiKey', 'b-anthropic-key']]) $(id).placeholder = c[`has_${k}`] ? 'Stored. Leave empty to keep it' : id.includes('gemini') ? 'AIza…' : 'sk-ant-…';
    renderBrain();
  }

  /** Why Save can't be pressed yet: a typed key that hasn't passed Test. */
  function brainProblem() {
    if (!info) return 'Loading…';
    for (const [kind, id] of [['anthropic', 'b-anthropic-key'], ['gemini', 'b-gemini-key']]) {
      if (!$(id).value.trim()) continue;
      if (tested[kind] === false) return 'That key was rejected.';
      if (!tested[kind]) return 'Press Test to check the key.';
    }
    return null;
  }

  function renderBrain() {
    if (!info) return;
    const f = info.found;
    chip($('bc-claude-code'), !f.claude.path ? 'Not installed' : !f.claude.loggedIn ? 'Sign in needed' : 'Ready', ccReady() ? 'ok' : f.claude.path ? 'warn' : '');
    $('b-cc-note').textContent = !f.claude.path ? 'Not found. To install, in Terminal: npm install -g @anthropic-ai/claude-code, then claude once to sign in. Already installed? Run which claude in Terminal, add that folder to PATH in ~/.zprofile and reopen JARVIS.'
      : !f.claude.loggedIn ? 'Run claude in Terminal once and sign in.' : `Version ${String(f.claude.version || '').replace(/\s*\(Claude Code\)/i, '')}. Uses your Claude plan, and runs the background worker.`;
    chip($('bc-ollama'), !ol.installed ? 'Not installed' : !ol.running ? 'Not running' : ol.models.length ? `Ready · ${ol.models.length} model${ol.models.length === 1 ? '' : 's'}` : 'No model yet', ol.running && ol.models.length ? 'ok' : ol.installed ? 'warn' : '');
    chip($('bc-gemini'), info.cfg.has_geminiApiKey ? 'Key stored' : 'No key', info.cfg.has_geminiApiKey ? 'ok' : '');
    chip($('bc-anthropic'), info.cfg.has_anthropicApiKey ? 'Key stored' : 'No key', info.cfg.has_anthropicApiKey ? 'ok' : '');
    renderOllama();
    const why = brainProblem();
    $('b-save').disabled = !!why;
    if (why) msg('b-msg', why, ''); else if (!/Saved|Restart|works/.test($('b-msg').textContent)) msg('b-msg', '');
  }

  function renderOllama() {
    const btn = $('b-ol-action');
    $('b-ol-text').textContent = !ol.installed ? 'Free and private: models run on this Mac. JARVIS can download it from ollama.com.'
      : !ol.running ? 'Installed but not running.'
      : ol.models.length ? 'Running. Agents set to Ollama can use the models below.' : 'Running. Download a model; it only downloads once.';
    btn.hidden = ol.running;
    btn.disabled = !!olBusy;
    btn.textContent = !ol.installed ? (olBusy === 'install' ? 'Installing…' : 'Install Ollama') : (olBusy === 'start' ? 'Starting…' : 'Start Ollama');
    const rows = [];
    if (ol.running) {
      for (const m of ol.models) {
        const rec = ol.recommended.find((r) => m === r.id || m.startsWith(r.id + ':'));
        rows.push({ id: m.replace(/:latest$/, ''), name: rec ? rec.name : m, note: rec ? rec.note : 'Installed', installed: true });
      }
      for (const r of ol.recommended) if (!hasModel(r.id)) rows.push({ ...r, installed: false });
    }
    const ul = $('b-ol-models');
    ul.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = r.installed ? 'ready' : '';
      li.innerHTML = '<span class="dot"></span><div><b></b><small></small></div><em></em>';
      li.querySelector('b').textContent = r.name;
      li.querySelector('small').textContent = r.note + (r.size && !r.installed ? ` · ${r.size}` : '');
      const em = li.querySelector('em');
      if (r.installed) em.textContent = 'Ready';
      else {
        const b = document.createElement('button');
        b.className = 'btn'; b.textContent = olBusy === r.id ? 'Downloading…' : 'Download'; b.disabled = !!olBusy;
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
    const patch = { ollamaUrl: $('b-ol-url').value.trim(), geminiApiKey: $('b-gemini-key').value.trim(), anthropicApiKey: $('b-anthropic-key').value.trim() };
    msg('b-msg', 'Saving…');
    lastSave = 'b';
    ask('cfg:save', { patch });
  }

  // ---------- access ----------

  const PERM = { allowed: ['Allowed', 'ok'], 'not-asked': ['Not yet', 'warn'], denied: ['Not allowed', 'bad'], unknown: ['—', ''], absent: ['Not installed', ''] };
  function renderPerms() {
    document.querySelectorAll('#hud-perms li').forEach((li) => {
      const k = li.dataset.perm;
      const st = k === 'notifications' ? (notified ? 'allowed' : 'not-asked') : perms[k] || 'unknown';
      const [label, cls] = k === 'notifications' && notified ? ['Test sent', 'ok'] : PERM[st] || PERM.unknown;
      chip(li.querySelector('.chip'), label, cls);
      const b = li.querySelector('button');
      b.hidden = st === 'allowed' || st === 'absent';
      b.disabled = false;
      b.textContent = st === 'denied' ? 'Open System Settings' : k === 'notifications' ? 'Send a test' : 'Allow';
    });
  }

  // ---------- telegram & extras ----------

  function loadExtras() {
    const c = info.cfg;
    $('x-tg-token').placeholder = c.has_telegramToken ? 'Stored. Leave empty to keep it' : '123456:ABC…';
    $('x-tg-chat').value = c.telegramChatId || '';
    $('x-tg-voice').checked = !!c.telegramVoiceReplies;
    $('x-radio').value = c.radioCountry || 'IN';
    $('x-hooks').textContent = info.installed.hooks ? 'Installed' : 'Not installed';
    $('x-hooks-btn').textContent = info.installed.hooks ? 'Reinstall' : 'Install';
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
          if (ok && e.models) { const dl = $(`ag-${e.kind}-models`); if (dl) dl.replaceChildren(...[...(e.kind === 'gemini' ? ['gemini-flash-latest'] : []), ...e.models].map((m) => new Option('', String(m)))); }
          msg('b-msg', ok ? 'Key works.' : `Key rejected: ${e.msg || 'failed'}.`, ok ? 'ok' : 'bad');
          renderBrain();
          if (ok) msg('b-msg', 'Key works. Press Save to use it.', 'ok');
        } else if (e.kind === 'telegram') msg('x-msg', ok ? `Bot ${e.msg} works.` : `Token rejected: ${e.msg || 'failed'}.`, ok ? 'ok' : 'bad');
        else if (e.kind === 'elevenlabs') { const out = document.querySelector('.sp:not([hidden]) .sp-inline'); if (out) out.remove(); flash(ok ? `ElevenLabs key works · ${(e.voices || []).length} voices.` : `ElevenLabs key rejected: ${e.msg || 'failed'}.`, ok); }
        break;
      }
      case 'cfg-perms': perms = e; renderPerms(); break;
      case 'cfg-hooks': $('x-hooks').textContent = e.ok ? 'Installed' : `Failed: ${e.msg || ''}`.slice(0, 60); break;
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
      case 'devices': renderDevices(e); break;
    }
  }

  // ---------- devices ----------

  function dNote(text, bad) { $('d-note').textContent = text || ''; $('d-note').className = 'note' + (bad ? ' bad' : text ? ' ok' : ''); }
  function renderDevices(e) {
    if (e.error) dNote(e.error, true); else if (e.done) dNote(e.done);
    if (document.activeElement !== $('d-name')) $('d-name').value = e.name || '';
    $('d-relay').checked = !!(e.relay && e.relay.on);
    if (document.activeElement !== $('d-relay-url')) $('d-relay-url').value = (e.relay && e.relay.url) || '';
    const list = e.list || [];
    $('d-count').textContent = list.length ? String(list.length) : '';
    $('sc-devices').textContent = list.length ? `${list.length} paired` : 'Your other computers';
    const VIA = { 'local network': ['Connected on your Wi-Fi', 'ok'], direct: ['Connected directly', 'ok'], relay: ['Through the relay', 'warn'], offline: ['Not reachable', 'bad'] };
    $('d-list').replaceChildren(...(list.length ? list.map((d) => {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = d.name;
      const ds = document.createElement('span'); ds.className = 'ds'; ds.textContent = `${d.os || ''}${d.lastSeen ? ` · last seen ${d.lastSeen.replace('T', ' ')}` : ''}`;
      const st = document.createElement('i'); const [label, cls] = VIA[d.via] || [d.via, '']; chip(st, label, cls);
      const rm = document.createElement('button'); rm.className = 'btn small'; rm.textContent = 'Remove';
      rm.addEventListener('click', () => { if (confirm(`Unpair ${d.name}? It won't be able to send tasks here, or get them from here. Unpair it on that device too.`)) ask('dev:remove', { id: d.id }); });
      li.append(nm, ds, st, rm);
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No other devices yet' })]));
    // Pairing: a code being shown, waiting for the other side, or done.
    const p = e.pair || null;
    if (p && p.state === 'waiting') {
      $('d-pairing').hidden = false; $('d-pair-start').hidden = true;
      $('d-code').textContent = p.code || '';
      $('d-code').hidden = !p.code;
      $('d-pair-msg').textContent = p.role === 'host' ? `Type this code in JARVIS on the other device, under Settings › Devices. It works for ${p.minutes} minutes.` : 'Looking for the other device…';
    } else if (p || !e.pairing) {
      $('d-pairing').hidden = true; $('d-pair-start').hidden = false;
      if (p && p.state === 'paired') { dNote(`Paired with ${p.name}.`); $('d-join-code').value = ''; }
      if (p && p.state === 'expired') dNote('The pairing code ran out. Show a new one.', true);
    }
  }
  $('d-host').addEventListener('click', () => { dNote('Getting a code…'); ask('dev:host'); });
  $('d-join').addEventListener('click', () => { const code = $('d-join-code').value.trim(); if (!code) return; dNote('Looking for the other device…'); ask('dev:join', { code }); $('d-pairing').hidden = false; $('d-pair-start').hidden = true; $('d-code').hidden = true; $('d-pair-msg').textContent = 'Looking for the other device…'; });
  $('d-cancel').addEventListener('click', () => { ask('dev:cancel'); dNote(''); });
  $('d-name-save').addEventListener('click', () => ask('dev:name', { value: $('d-name').value }));
  $('d-relay').addEventListener('change', () => ask('dev:relay', { on: $('d-relay').checked }));
  $('d-relay-save').addEventListener('click', () => ask('dev:relay', { url: $('d-relay-url').value }));

  function flash(text, ok) {
    const p = document.querySelector(`.sp[data-page="${page}"]`);
    if (!p) return;
    const el = document.createElement('p');
    el.className = 'note sp-inline' + (ok ? ' ok' : ' bad');
    el.textContent = text;
    p.appendChild(el);
  }

  // ---------- wiring ----------

  document.querySelectorAll('#setnav .navitem').forEach((b) => b.addEventListener('click', () => open(b.dataset.section)));
  document.querySelectorAll('#nav a[data-view="settings"]').forEach((a) => a.addEventListener('click', home));
  $('b-ol-action').addEventListener('click', () => ollamaDo(ol.installed ? 'start' : 'install'));
  $('b-ol-check').addEventListener('click', () => ask('cfg:ollama', { action: 'state', url: $('b-ol-url').value.trim() }));
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
  $('x-hooks-btn').addEventListener('click', () => { $('x-hooks').textContent = 'Installing…'; ask('cfg:hooks'); });
  document.querySelectorAll('#hud-perms li').forEach((li) => li.querySelector('button').addEventListener('click', (ev) => {
    ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Asking…';
    if (li.dataset.perm === 'notifications') notified = true;
    ask('cfg:perms', { op: 'ask', which: li.dataset.perm });
  }));
  const stt = document.querySelector('[data-key="sttEngine"]');
  if (stt) stt.addEventListener('change', syncRows);
  // Back from System Settings: refresh what changed.
  window.addEventListener('focus', () => { if (page === 'access') ask('cfg:perms', { op: 'state' }); });

  open('general');
  window.jarvisSettings = { open, home, event };
})();
