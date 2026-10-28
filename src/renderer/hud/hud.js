/* JARVIS Command Center — Three.js core globe + view-switched dashboard.
   Contract: native calls window.hud.event(obj); page posts to webkit.messageHandlers.jarvis. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const DEMO = /[?&]demo=1/.test(location.search) || location.hash === '#demo' || typeof window.webkit === 'undefined';
  const T0 = performance.now();

  // ---------- native bridge ----------
  function postLocal(msg) {
    try { window.webkit.messageHandlers.jarvis.postMessage(msg); } catch (e) { /* not in WKWebView */ }
  }
  // While another device's tab is open, what is typed and what is changed in its agents goes to it.
  const REMOTE_ACTS = new Set(['assistant', 'assistant-update', 'assistant-create', 'assistant-delete', 'assistant-reset', 'assistant-try']);
  let machine = '';   // '' is this device; otherwise the id of the device whose tab is open
  const views = { '': {} };        // device id ('' = this one) -> { event type: latest event }
  let devList = [], devName = '';  // paired devices, and this device's name
  let popping = false;             // the crew being rebuilt because a group node opened
  let burstFrom = null;            // where it opened from: { x, y } in the crew's coordinates
  function post(msg) {
    if (machine && msg && msg.type === 'action') {
      if (msg.name === 'type') return postLocal({ type: 'action', name: 'dev:say', device: machine, text: msg.text });
      if (REMOTE_ACTS.has(msg.name)) return postLocal({ type: 'action', name: 'dev:act', device: machine, action: msg });
    }
    postLocal(msg);
  }

  // ---------- palette / states ----------
  const COL = {
    cyan: new THREE.Color(0x39c3ff), dim: new THREE.Color(0x1b4d73), amber: new THREE.Color(0xffb347),
    green: new THREE.Color(0x7dffb3), red: new THREE.Color(0xff4d4d), grey: new THREE.Color(0x6b7a8a), white: new THREE.Color(0xffffff),
  };
  const STATES = {
    booting:   { color: COL.dim,   spin: 0.15, ringSpin: 0.2,  ringScale: 1.0,  jitter: 0,    core: 0.6, opacity: 0.55, breathe: 0.02 },
    idle:      { color: COL.cyan,  spin: 0.18, ringSpin: 0.35, ringScale: 1.0,  jitter: 0,    core: 1.0, opacity: 0.9,  breathe: 0.035 },
    listening: { color: COL.green, spin: 0.25, ringSpin: 0.6,  ringScale: 1.08, jitter: 0.02, core: 1.1, opacity: 1.0,  breathe: 0.02 },
    thinking:  { color: COL.amber, spin: 0.9,  ringSpin: -1.8, ringScale: 1.03, jitter: 0.01, core: 1.3, opacity: 1.0,  breathe: 0.05 },
    speaking:  { color: COL.cyan,  spin: 0.3,  ringSpin: 0.8,  ringScale: 1.0,  jitter: 0,    core: 1.2, opacity: 1.0,  breathe: 0.0 },
    error:     { color: COL.red,   spin: 0.4,  ringSpin: 0.5,  ringScale: 1.0,  jitter: 0.03, core: 1.2, opacity: 1.0,  breathe: 0.12 },
    muted:     { color: COL.grey,  spin: 0.04, ringSpin: 0.05, ringScale: 0.96, jitter: 0,    core: 0.4, opacity: 0.3,  breathe: 0.0 },
  };
  const STATE_WORD = { booting: 'Booting…', idle: 'Idle — say Jarvis', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', error: 'Error', muted: 'Deactivated' };
  const SYS_WORD = { booting: 'BOOTING', idle: 'OPTIMAL', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'RESPONDING', error: 'FAULT', muted: 'STANDBY' };
  let state = 'booting';
  const cur = { color: COL.dim.clone(), spin: 0.15, ringSpin: 0.2, ringScale: 1, jitter: 0, core: 0.6, opacity: 0.55, breathe: 0.02 };
  let flash = 0, micLevel = 0, voiceLevel = 0, conversation = false;
  const boot = { t: 0, done: false, assembled: false };
  const stats = { turns: 0, toolCalls: 0, memories: null, sessionsActive: 0, brainReady: false, brainModel: '', effort: '', tts: '', stt: '', telegram: 'off', agents: [] };
  const info = { claude: '', model: '', voice: '' };
  let host = '';

  // ---------- three.js globe ----------
  const stage = $('stage');
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 6);
  const R = 0.72, OUTER = 1.16;

  function dotTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.15)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function ringTexture(inner, width) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(Math.max(0, inner - width), 'rgba(255,255,255,0)');
    grd.addColorStop(inner, 'rgba(255,255,255,1)'); grd.addColorStop(Math.min(1, inner + width), 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  const DOT = dotTexture(), HALO = ringTexture(0.80, 0.05), HALO2 = ringTexture(0.95, 0.025);

  const N = 2600;
  const target = new Float32Array(N * 3), pos = new Float32Array(N * 3), start = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    target[i * 3] = Math.cos(th) * r * R; target[i * 3 + 1] = y * R; target[i * 3 + 2] = Math.sin(th) * r * R;
    const far = 3 + Math.random() * 5, a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * Math.PI;
    start[i * 3] = Math.cos(a) * Math.cos(b) * far; start[i * 3 + 1] = Math.sin(b) * far; start[i * 3 + 2] = Math.sin(a) * Math.cos(b) * far;
    pos[i * 3] = start[i * 3]; pos[i * 3 + 1] = start[i * 3 + 1]; pos[i * 3 + 2] = start[i * 3 + 2];
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pmat = new THREE.PointsMaterial({ size: 0.026, map: DOT, color: COL.cyan, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const particles = new THREE.Points(pgeo, pmat);
  scene.add(particles);

  const globeMat = new THREE.LineBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending });
  const globe = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 0.98, 18, 12)), globeMat);
  scene.add(globe);

  const haloMat = new THREE.SpriteMaterial({ map: HALO, color: COL.cyan, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const halo = new THREE.Sprite(haloMat); halo.scale.set(R * 2.56, R * 2.56, 1); scene.add(halo);
  const halo2Mat = new THREE.SpriteMaterial({ map: HALO2, color: COL.cyan, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const halo2 = new THREE.Sprite(halo2Mat); halo2.scale.set(2.36, 2.36, 1); scene.add(halo2);
  const glowMat = new THREE.SpriteMaterial({ map: DOT, color: COL.cyan, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Sprite(glowMat); glow.scale.set(1.6, 1.6, 1); scene.add(glow);
  const coreMat = new THREE.SpriteMaterial({ map: DOT, color: COL.white, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Sprite(coreMat); core.scale.set(0.35, 0.35, 1); scene.add(core);
  const icoMat = new THREE.LineBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending });
  const ico = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.34, 1)), icoMat);
  scene.add(ico);

  function arcGeometry(r, a0, a1, segs) {
    const pts = [];
    for (let i = 0; i <= segs; i++) { const a = a0 + (a1 - a0) * (i / segs); pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }
  function ticksGeometry(r0, r1, count, skipEvery) {
    const pts = [];
    for (let i = 0; i < count; i++) {
      if (skipEvery && i % skipEvery === 0) continue;
      const a = (i / count) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, 0), new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }
  const ringMats = [];
  function ringMat(op) { const m = new THREE.LineBasicMaterial({ color: COL.cyan, transparent: true, opacity: op, blending: THREE.AdditiveBlending }); ringMats.push(m); return m; }

  const arcs = [];
  const ARC_SPECS = [
    { r: 0.80, spans: [[0, 1.9], [2.4, 3.9], [4.4, 5.6]], speed: 0.35, op: 0.9 },
    { r: 0.86, spans: [[0.3, 0.9], [1.6, 3.3], [3.9, 5.9]], speed: -0.22, op: 0.7 },
    { r: 0.93, spans: [[0, 2.6], [3.2, 5.2]], speed: 0.16, op: 0.8, ticks: true },
    { r: 1.00, spans: [[0.2, 1.1], [1.5, 2.1], [2.6, 4.9], [5.3, 6.0]], speed: -0.5, op: 0.6 },
    { r: 1.06, spans: [[0, 0.5], [1.2, 2.9], [3.6, 4.1], [4.7, 6.1]], speed: 0.27, op: 0.65, ticks: true },
  ];
  ARC_SPECS.forEach((s) => {
    const g = new THREE.Group();
    s.spans.forEach(([a0, a1]) => g.add(new THREE.Line(arcGeometry(s.r, a0, a1, 48), ringMat(s.op))));
    if (s.ticks) g.add(new THREE.LineSegments(ticksGeometry(s.r - 0.012, s.r + 0.012, 36, 0), ringMat(s.op * 0.8)));
    g.userData.speed = s.speed; g.userData.startScale = 2.6 + Math.random() * 1.5;
    g.scale.setScalar(g.userData.startScale);
    scene.add(g); arcs.push(g);
  });
  const dial = new THREE.Group();
  dial.add(new THREE.LineSegments(ticksGeometry(1.10, 1.135, 36, 9), ringMat(0.55)));
  dial.add(new THREE.LineSegments(ticksGeometry(1.085, 1.15, 4, 0), ringMat(0.9)));
  dial.add(new THREE.Line(arcGeometry(1.12, 0, Math.PI * 2, 128), ringMat(0.12)));
  dial.userData.startScale = 3.5; dial.scale.setScalar(3.5);
  scene.add(dial);
  const sweep = new THREE.Line(arcGeometry(1.12, 0, 0.55, 24), new THREE.LineBasicMaterial({ color: COL.white, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  dial.add(sweep); ringMats.push(sweep.material);

  const tilted = [];
  [[0.95, 1.1, 0.0], [1.02, 0.4, 1.0], [0.88, -0.9, 0.6]].forEach(([r, rx, ry], i) => {
    const g = new THREE.Group();
    g.add(new THREE.LineLoop(arcGeometry(r, 0, Math.PI * 2, 160), ringMat(0.22)));
    g.rotation.set(rx, ry, 0); g.userData.speed = i % 2 ? -0.18 : 0.25; g.userData.startScale = 3;
    g.scale.setScalar(3); scene.add(g); tilted.push(g);
  });

  const SAT = 14;
  const satPos = new Float32Array(SAT * 3), satGeo = new THREE.BufferGeometry();
  satGeo.setAttribute('position', new THREE.BufferAttribute(satPos, 3));
  const satMat = new THREE.PointsMaterial({ size: 0.07, map: DOT, color: COL.white, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const sats = new THREE.Points(satGeo, satMat); scene.add(sats);
  const satOrb = Array.from({ length: SAT }, (_, i) => ({ r: 0.95 + (i % 4) * 0.07, a: Math.random() * Math.PI * 2, s: (0.15 + Math.random() * 0.25) * (i % 2 ? 1 : -1), tilt: (i % 3) * 0.5 - 0.5 }));

  // dotted outer ring + 24 small markers (classic HUD look), rotates slowly
  const dotted = new THREE.Group();
  (function () {
    const n = 144, pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 1.2, Math.sin(a) * 1.2, 0)); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.PointsMaterial({ size: 0.022, map: DOT, color: COL.cyan, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    ringMats.push(m); dotted.add(new THREE.Points(g, m));
    const mk = [];
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); mk.push(new THREE.Vector3(c * 1.23, sn * 1.23, 0), new THREE.Vector3(c * 1.27, sn * 1.27, 0)); }
    dotted.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(mk), ringMat(0.9)));
    dotted.add(new THREE.Line(arcGeometry(1.0, 0, Math.PI * 2, 160), ringMat(0.5)));   // thin solid ring
    dotted.userData.startScale = 3; dotted.scale.setScalar(3); scene.add(dotted);
  })();

  const bolts = [];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(10 * 3), 3));
    const m = new THREE.LineBasicMaterial({ color: COL.white, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, m); line.userData.life = 0; scene.add(line); bolts.push(line);
  }
  function fireBolt() {
    const b = bolts.find((x) => x.userData.life <= 0); if (!b) return;
    const a = Math.random() * Math.PI * 2, ph = (Math.random() - 0.5) * 2.4;
    const end = new THREE.Vector3(Math.cos(a) * Math.cos(ph), Math.sin(ph), Math.sin(a) * Math.cos(ph)).multiplyScalar(R * cur.ringScale);
    const arr = b.geometry.attributes.position.array;
    for (let i = 0; i < 10; i++) {
      const t = i / 9, j = (i === 0 || i === 9) ? 0 : 0.09;
      arr[i * 3] = end.x * t + (Math.random() - 0.5) * j; arr[i * 3 + 1] = end.y * t + (Math.random() - 0.5) * j; arr[i * 3 + 2] = end.z * t + (Math.random() - 0.5) * j;
    }
    b.geometry.attributes.position.needsUpdate = true;
    b.userData.life = 1;
  }

  // reactor diameter ≈ 0.8 × the panel's shorter side
  function resize() {
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const want = (1.3 * 2) / 0.96;
    const dist = h <= w ? (want / 2) / tanHalf : ((want / 2) / camera.aspect) / tanHalf;
    camera.position.z = dist;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---------- the assistants: the one in use is the core, inside a loose web of neurons ----------
  // The other four are larger nodes in that web; signals run to each of them from the core along the
  // shortest chain of neurons. Clicking one brings it to the centre, to switch to it.
  // x, y: their place in the web (full mode). nx, ny: just outside the reactor ring in the normal view,
  // where the side panels leave room even on a laptop screen.
  // The first four also have a place in the normal view; more of the user's own only show in the web.
  const SLOTS = [{ x: 21, y: -53, nx: 30, ny: -46 }, { x: 73, y: 24, nx: 42, ny: 30 }, { x: -79, y: -14, nx: -42, ny: -30 }, { x: -38, y: 50, nx: -30, ny: 46 },
    { x: -36, y: -50, extra: true }, { x: 64, y: -30, extra: true }, { x: -76, y: 30, extra: true }, { x: 40, y: 52, extra: true }];
  // Until main sends the list (main/assistants.js).
  let assistants = [
    { id: 'jarvis', name: 'JARVIS', tier: 'BALANCED', about: 'Fast and smart. Quick replies, strong background work.', needs: 'Claude Code (or an API key)' },
    { id: 'friday', name: 'FRIDAY', tier: 'MAXIMUM', about: 'The smartest. Thinks hardest, so she answers more slowly.', needs: 'Claude Code' },
    { id: 'karen', name: 'KAREN', tier: 'LIGHT', about: 'The fastest and cheapest. Simpler answers.', needs: 'Claude Code' },
    { id: 'edith', name: 'EDITH', tier: 'PRIVATE', about: 'Runs on a local model on this Mac. Private, but the weakest.', needs: 'Ollama' },
    { id: 'vision', name: 'VISION', tier: 'NO CLAUDE NEEDED', about: "Runs on Google's Gemini, with a free tier.", needs: 'A Gemini API key' },
  ];
  let current = 'jarvis';
  // The nodes around the core. 'main': the built-in agents, FORGE (the custom agents, dim until there is
  // one) and MESH (this computer and the user's others, dim until one is paired). A group node opens (explodes) into its members
  // and a node back: custom agents with a System node; one node per device; a device's built-in agents
  // with one node for its custom agents. Another device's agent opens that device's tab.
  let crewGroup = 'main';
  const groupNode = (group, name, role, about = '') => ({ id: 'g-' + group.replace(/[^\w-]/g, '_'), group, name, role, about });
  const agentNode = (a, dev) => ({ id: dev ? `r-${dev}-${a.id}` : a.id, agent: a.id, device: dev || '', name: a.name, role: a.tier, about: a.about, needs: a.needs, color: a.color });
  // Only the first four slots show in the normal view: group and back nodes take those first, so they
  // can always be clicked; the agents that don't fit there show in full mode.
  const place = (agents, groups) => { const k = Math.max(0, 4 - groups.length); return [...agents.slice(0, k), ...groups, ...agents.slice(k)]; };
  function crewItems() {
    const others = assistants.filter((a) => a.id !== current);
    const builtIn = others.filter((a) => !a.custom), custom = others.filter((a) => a.custom);
    const devs = machine ? [] : remoteDevices();
    const sys = groupNode('main', 'SYSTEM', 'BUILT-IN AGENTS');
    if (crewGroup === 'custom') return place(custom.map((a) => agentNode(a)), [{ ...groupNode('create', '+ CREATE', 'MAKE AN AGENT'), dim: true }, sys]);
    if (crewGroup === 'devices') {
      // Every paired computer (dim when it can't be reached), and one more to pair a new one.
      const nodes = devList.map((d) => ({ ...groupNode('device:' + d.id, d.name.toUpperCase(), d.via === 'offline' ? 'NOT REACHABLE' : (d.os || 'DEVICE').toUpperCase(), d.via), dim: d.via === 'offline' }));
      const self = groupNode('main', (devName || 'This computer').toUpperCase(), 'THIS COMPUTER');
      self.id = 'g-self';
      return place([self, ...nodes], [{ ...groupNode('pair', '+ PAIR', 'ADD A COMPUTER'), dim: true }, sys]);
    }
    const dm = /^(device|dcustom):(.+)$/.exec(crewGroup);
    if (dm) {
      const d = devs.find((x) => x.id === dm[2]);
      if (!d) { crewGroup = 'main'; return crewItems(); }
      const rest = d.list.filter((a) => a.id !== d.current);
      if (dm[1] === 'dcustom') return place(rest.filter((a) => a.custom).map((a) => agentNode(a, d.id)), [groupNode('device:' + d.id, d.name.toUpperCase(), 'BACK')]);
      return place(rest.filter((a) => !a.custom).map((a) => agentNode(a, d.id)), [
        ...(rest.some((a) => a.custom) ? [groupNode('dcustom:' + d.id, 'CUSTOM', `${d.name.toUpperCase()} · ${rest.filter((a) => a.custom).length} AGENTS`)] : []),
        groupNode('devices', 'MESH', 'BACK')]);
    }
    return place(builtIn.map((a) => agentNode(a)), [
      { ...groupNode('custom', 'FORGE', custom.length ? `${custom.length} CUSTOM AGENT${custom.length > 1 ? 'S' : ''}` : 'MAKE YOUR OWN'), dim: !custom.length },
      ...(machine ? [] : [{ ...groupNode('devices', 'MESH', devList.length ? `${devList.length} CONNECTED` : 'PAIR A COMPUTER'), dim: !devList.length }])]);
  }
  const hubsFor = () => crewItems().slice(0, SLOTS.length).map((a, i) => ({ nx: SLOTS[i].x, ny: SLOTS[i].y, ...SLOTS[i], ...a }));
  let HUBS = hubsFor();
  const crew = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  crew.id = 'crew';
  crew.setAttribute('viewBox', '-50 -50 100 100');
  crew.setAttribute('aria-hidden', 'true');
  crew.innerHTML = buildCrew();
  stage.appendChild(crew);

  function buildCrew() {
    let seed = 23;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const f = (n) => n.toFixed(2);
    const R0 = 42, IN = 46, RX = 98, RY = 62;
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const nodes = HUBS.map((h) => ({ ...h, hub: true, r: 1.1 }));
    const fits = (p, gap) => nodes.every((q) => dist(p, q) > (q.hub ? gap + 3 : gap));
    // neurons scattered between the reactor and an ellipse, more of them near each hub
    for (let tries = 0; nodes.length < 40 && tries < 4000; tries++) {
      const t = rnd() * 2 * Math.PI, c = Math.cos(t), sn = Math.sin(t);
      const outer = 1 / Math.sqrt((c * c) / (RX * RX) + (sn * sn) / (RY * RY));
      const r = IN + Math.pow(rnd(), 1.3) * (outer - IN);
      const p = { x: r * c, y: r * sn, r: 0.28 + rnd() * 0.4 };
      if (fits(p, 9)) nodes.push(p);
    }
    HUBS.forEach((h) => {
      for (let k = 0, tries = 0; k < 4 && tries < 200; tries++) {
        const t = rnd() * 2 * Math.PI, r = 4 + rnd() * 7, p = { x: h.x + r * Math.cos(t), y: h.y + r * Math.sin(t), r: 0.35 + rnd() * 0.35 };
        if (Math.hypot(p.x, p.y) > IN && fits(p, 3.5)) { nodes.push(p); k++; }
      }
    });
    // each node links to its two or three nearest neighbours; hubs to five
    const edges = new Map(), adj = nodes.map(() => []);
    nodes.forEach((p, i) => {
      const k = p.hub ? 4 : 2 + (rnd() < 0.15 ? 1 : 0);
      nodes.map((q, j) => [j, dist(p, q)]).filter(([j, d]) => j !== i && d < 24).sort((u, v) => u[1] - v[1]).slice(0, k).forEach(([j]) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!edges.has(key)) { edges.set(key, [i, j]); adj[i].push(j); adj[j].push(i); }
      });
    });
    // neurons close to the reactor take signals straight from the brain
    const roots = nodes.map((p, i) => i).filter((i) => !nodes[i].hub && Math.hypot(nodes[i].x, nodes[i].y) < 53);
    const rootPt = (p) => { const a = Math.atan2(p.y, p.x); return { x: R0 * Math.cos(a), y: R0 * Math.sin(a) }; };
    // shortest chain from the brain to a hub
    const chain = (goal) => {
      const prev = new Map(roots.map((i) => [i, -1])), queue = [...roots];
      while (queue.length) {
        const i = queue.shift();
        if (i === goal) break;
        for (const j of adj[i]) if (!prev.has(j)) { prev.set(j, i); queue.push(j); }
      }
      const path = [];
      for (let i = goal; i !== -1 && i !== undefined; i = prev.get(i)) path.unshift(i);
      return path;
    };
    // a smooth curve through the points (Catmull-Rom as cubic Béziers)
    const curve = (pts) => {
      let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        d += ` C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)},${f(p2.y)}`;
      }
      return d;
    };
    const fade = (p) => f(Math.max(0.25, 1 - (Math.hypot(p.x, p.y) - IN) / 70));

    let field = '';
    for (const [i, j] of edges.values()) {
      const p = nodes[i], q = nodes[j];
      field += `<line class="syn" x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}" stroke-opacity="${fade(p)}" style="--d:${f(rnd() * 3.6)}s"/>`;
    }
    roots.forEach((i) => {
      const p = nodes[i], o = rootPt(p);
      field += `<line class="axon" x1="${f(o.x)}" y1="${f(o.y)}" x2="${f(p.x)}" y2="${f(p.y)}"/><circle class="term" cx="${f(o.x)}" cy="${f(o.y)}" r="0.45"/>`;
    });
    nodes.forEach((p) => { if (!p.hub) field += `<circle class="nrn" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}" fill-opacity="${fade(p)}" style="--d:${f(rnd() * 4)}s"/>`; });

    const mates = HUBS.map((h, n) => {
      const path = chain(n), pts = path.map((i) => nodes[i]);
      if (pts.length) pts.unshift(rootPt(pts[0]));
      const d = pts.length > 1 ? curve(pts) : '';
      const sparks = d ? [0, 1].map((k) => `<circle class="spark" r="0.6"><animateMotion dur="${f(2.4 + pts.length * 0.35)}s" begin="${f(k * 1.3 + rnd())}s" repeatCount="indefinite" path="${d}"/></circle>`).join('') : '';
      const right = h.x >= 0, lx = h.x + (right ? 5.5 : -5.5), anchor = right ? 'start' : 'end';
      // Opened from a group node: each new node starts there and flies out to its place.
      const full = body.classList.contains('focus') || body.classList.contains('spot');
      const burst = popping && burstFrom ? `;--dx:${f(burstFrom.x - (full ? h.x : h.nx))};--dy:${f(burstFrom.y - (full ? h.y : h.ny))}` : '';
      return `<g class="mate${h.extra ? ' extra' : ''}${h.group ? ' group' : ''}${h.dim ? ' dim' : ''}${burst ? ' pop' : ''}" id="crew-${h.id}" data-id="${h.id}" style="--i:${n};--hx:${h.x};--hy:${h.y};--nx:${h.nx};--ny:${h.ny}${burst}${/^#[0-9a-f]{6}$/i.test(h.color || '') ? `;--cyan:${h.color}` : ''}"><g class="mi">`
        + (d ? `<path class="fire" d="${d}" style="--d:${f(rnd())}s"/>` : '') + sparks
        + `<circle class="hit" cx="${f(h.x)}" cy="${f(h.y)}" r="7"/><circle class="aura" cx="${f(h.x)}" cy="${f(h.y)}" r="5.6"/><circle class="halo" cx="${f(h.x)}" cy="${f(h.y)}" r="3.4"/><circle class="ring" cx="${f(h.x)}" cy="${f(h.y)}" r="2.1"/><circle class="core" cx="${f(h.x)}" cy="${f(h.y)}" r="1.05"/>`
        + `<text class="nm" text-anchor="${anchor}" x="${f(lx)}" y="${f(h.y - 0.3)}">${h.name}</text>`
        + `<text class="rl" text-anchor="${anchor}" x="${f(lx)}" y="${f(h.y + 2.6)}">${h.role}</text>`
        + `<text class="nm2" text-anchor="middle" x="${f(h.x)}" y="${f(h.y + 6.4)}">${h.name}</text>`
        + `<text class="rl2" text-anchor="middle" x="${f(h.x)}" y="${f(h.y + 8.6)}">${h.role}</text></g></g>`;
    }).join('');
    // the normal view's simple links from the reactor's edge to each assistant
    const tethers = HUBS.filter((h) => !h.extra).map((h) => {
      const a = Math.atan2(h.ny, h.nx), d = Math.hypot(h.nx, h.ny) - 3.6;
      return `<line class="tether" id="tether-${h.id}" x1="${f(R0 * Math.cos(a))}" y1="${f(R0 * Math.sin(a))}" x2="${f(d * Math.cos(a))}" y2="${f(d * Math.sin(a))}"/>`;
    }).join('');
    const flash = popping && burstFrom ? `<circle class="burst" cx="${f(burstFrom.x)}" cy="${f(burstFrom.y)}" r="3"/><circle class="burst b2" cx="${f(burstFrom.x)}" cy="${f(burstFrom.y)}" r="3"/>` : '';
    return `<g class="field">${field}</g><g class="tethers">${tethers}</g>${mates}${flash}`;
  }
  // The assistant in use changed: it becomes the core, the others move into the slots around it.
  function setAssistants(e) {
    if (Array.isArray(e.list) && e.list.length) { assistants = e.list; sel = { id: '' }; }
    if (e.env) env = e.env;
    if (e.roles) catalog = { roles: e.roles, tools: e.tools || {}, guards: e.guards || {} };
    if (e.id) current = e.id;
    if (e.edit) { editing = e.edit; aNote(`Made ${(assistants.find((a) => a.id === e.edit) || {}).name}. Change it here, then use it.`); }
    if (e.edit && making) { making = false; unspot(); crewGroup = 'custom'; setTimeout(() => showView('agents'), 0); }
    else if (e.list) aNote('');
    const me = assistants.find((a) => a.id === current) || assistants[0];
    if (spotted) unspot(false);
    HUBS = hubsFor();
    crew.innerHTML = buildCrew();
    crew.classList.toggle('busy', (stats.agents || []).length > 0);
    document.querySelector('#brand .word').textContent = me.name.split('').join('.');
    coreLabel();
    document.title = me.name.split('').join('.');
    $('ask-input').placeholder = `Type to ${me.name}…`;
    $('power').querySelector('b').textContent = `${body.classList.contains('disabled') ? 'ENABLE' : 'DISABLE'} ${me.name}`;
    renderAssistantCards();
    if (ext.skills.length) renderSkillsPage();
  }
  // ---------- the Agents tab ----------
  // A card for each agent on the left; the open one's whole setup on the right. Save stores it for that
  // agent, whether or not it is the one in use. env: what main says is set up (brains, Ollama's models,
  // the speech engine every agent shares).
  let editing = '', filled = '';
  let env = { ready: {}, ollamaModels: [], engine: 'kokoro' };
  let catalog = { roles: {}, tools: {}, guards: {} };   // the roles, tools and safety levels to choose from
  const okColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const paint = (elx, c) => { if (okColor(c)) elx.style.setProperty('--cyan', c); else elx.style.removeProperty('--cyan'); };
  const BRAINS = { auto: 'Best available', 'claude-code': 'Claude Code', anthropic: 'Anthropic API', gemini: 'Gemini', ollama: 'Ollama' };
  const ENGINES = { kokoro: 'Kokoro', elevenlabs: 'ElevenLabs', edge: 'Edge neural', native: 'macOS voice' };
  const cap = (x) => { x = String(x || '').replace(/\bclaude\b/g, 'Claude'); return x.charAt(0).toUpperCase() + x.slice(1); };
  const field = (k) => document.querySelector(`#a-edit [data-s="${k}"]`);
  function brainLine(st) {
    const p = st.brainProvider;
    if (p === 'anthropic') return `Anthropic · ${st.anthropicModel}`;
    if (p === 'gemini') return `Gemini · ${st.geminiModel}`;
    if (p === 'ollama') return `Ollama · ${st.ollamaModel}`;
    return `Claude ${cap(st.model)} · ${st.effort} effort`;
  }
  function voiceLine(st) {
    if (env.engine === 'kokoro') { const o = [...field('kokoroVoice').options].find((x) => x.value === st.kokoroVoice); return o ? o.textContent.split(' (')[0] : st.kokoroVoice; }
    if (env.engine === 'edge') return String(st.edgeVoice || '').replace(/^\w\w-\w\w-|Neural$/g, '');
    if (env.engine === 'native') return st.nativeVoice;
    return 'ElevenLabs';
  }
  const workerOn = (st) => st.brainProvider === 'auto' || st.brainProvider === 'claude-code' || st.worker !== 'off';
  function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }

  function renderAssistantCards() {
    if (!assistants.some((a) => a.id === editing)) editing = current;
    $('n-agents').textContent = assistants.length;
    $('acards').replaceChildren(...assistants.map((a) => {
      const st = a.settings || {};
      const b = el('button', 'agcard' + (a.id === current ? ' on' : '') + (a.id === editing ? ' editing' : ''));
      b.dataset.id = a.id;
      const body = el('div', 'ag-txt');
      const n = el('div', 'n', a.name);
      if (a.id === current) n.append(el('span', 'badge on', 'In use'));
      else if (a.custom) n.append(el('span', 'badge', 'Your own'));
      else if (a.changed) n.append(el('span', 'badge', 'Changed'));
      const skills = a.skills ? a.skills.length : ext.skills.length;
      body.append(n, el('div', 't', cap(String(a.tier).toLowerCase())), el('div', 'm', brainLine(st)),
        el('div', 'm', [workerOn(st) ? `Worker ${cap(st.agentModel)}` : 'No worker', voiceLine(st), skills ? `${skills} skills` : ''].filter(Boolean).join(' · ')));
      const face = el('span', 'ag-face', a.name.charAt(0));
      paint(face, a.color);
      body.append(el('div', 'm', [catalog.roles[a.role] && a.role !== 'none' ? (a.role === 'custom' ? 'Own role' : catalog.roles[a.role]) : '', a.guard && a.guard !== 'standard' ? (catalog.guards[a.guard] || {}).label : ''].filter(Boolean).join(' · ')));
      b.append(face, body);
      b.addEventListener('click', () => { editing = a.id; renderAssistantCards(); });
      return b;
    }));
    const a = assistants.find((x) => x.id === editing);
    if (!a) return;
    $('a-edit-title').textContent = a.name;
    $('a-face').textContent = a.name.charAt(0);
    paint($('a-face'), a.color);
    $('a-export').title = `Save ${a.name} to a file`;
    $('a-edit-tier').textContent = cap(String(a.tier).toLowerCase()) + (a.needs ? ` · Needs ${a.needs}` : '');
    $('a-edit-about').textContent = a.about;
    $('a-use').hidden = a.id === current;
    $('a-use').textContent = `Use ${a.name}`;
    $('a-inuse').hidden = a.id !== current;
    $('a-reset').hidden = !a.changed;
    $('a-delete').hidden = !a.custom;
    const from = $('a-new-from'), keepFrom = from.value;
    from.replaceChildren(new Option('Start from scratch', 'blank'), ...assistants.map((x) => new Option(`Copy of ${x.name}`, x.id)));
    from.value = [...from.options].some((o) => o.value === keepFrom) ? keepFrom : 'blank';
    renderTraining(a);
    document.querySelectorAll('#a-edit [data-own]').forEach((li) => { li.hidden = !a.custom; });
    // Fill the form only when another agent opens or its saved setup changed, so typing isn't lost.
    const key = a.id + JSON.stringify([a.settings, a.persona, a.wakeWords, a.name, a.tier, a.about, a.role, a.roleText, a.commands, a.color, a.sharedMemory, a.guard, a.blockedPaths, a.tools, a.maintainer]);
    if (filled !== key) {
      if (filled.slice(0, a.id.length + 1) !== a.id + '[') { $('a-try-out').hidden = true; $('a-try-note').textContent = ''; }
      filled = key;
      $('a-role').replaceChildren(...Object.entries(catalog.roles).map(([k, label]) => new Option(k === a.defaultRole && k !== 'none' ? `${label} (its default)` : label, k)));
      $('a-role').value = a.role || 'none';
      $('a-role-text').value = a.roleText || '';
      cmds = (a.commands || []).map((c) => ({ ...c }));
      renderCmds();
      color = a.color || '';
      $('a-color').value = okColor(color) ? color : (getComputedStyle(document.body).getPropertyValue('--cyan').trim().match(/^#[0-9a-f]{6}$/i) || ['#3fd0ff'])[0];
      $('a-shared').checked = a.sharedMemory !== false;
      guard = a.guard || 'standard';
      renderGuard();
      $('a-blocked').value = (a.blockedPaths || []).join('\n');
      $('a-maint').checked = !!a.maintainer;
      $('a-name').value = a.name; $('a-tier').value = a.tier; $('a-about').value = a.about;
      $('a-wake').value = (a.wakeWords || []).join(', ');
      $('a-persona').value = a.persona || '';
      for (const [k, v] of Object.entries(a.settings || {})) {
        const f = field(k);
        if (!f) continue;
        if (f.tagName === 'SELECT' && v && ![...f.options].some((o) => o.value === String(v))) f.append(new Option(String(v), String(v)));
        f.value = v ?? '';
      }
    }
    if (sel.id !== a.id) sel = { id: a.id, skills: a.skills ? new Set(a.skills) : null, mcp: a.mcp ? new Set(a.mcp) : null, tools: a.tools ? new Set(a.tools) : null };
    syncAgent();
    syncRole();
    renderPicks();
  }

  // Rows that only apply to the chosen brain or the speech engine in use, and what still needs setting up.
  function syncAgent() {
    const p = field('brainProvider').value;
    document.querySelectorAll('#a-edit [data-brain]').forEach((li) => { li.hidden = !li.dataset.brain.split(' ').includes(p); });
    $('ag-agent-row').hidden = !workerOn({ brainProvider: p, worker: field('worker').value });
    document.querySelectorAll('#a-edit [data-engine]').forEach((li) => { li.hidden = li.dataset.engine !== env.engine; });
    const r = env.ready || {};
    const need = {
      'claude-code': 'Claude Code is not set up on this Mac. See Settings › Brains & keys.',
      anthropic: 'Add an Anthropic API key in Settings › Brains & keys first.',
      gemini: 'Add a Gemini API key in Settings › Brains & keys first.',
      ollama: 'Ollama is not running. Set it up in Settings › Brains & keys.',
    };
    const note = $('ag-brain-note');
    note.textContent = p === 'auto' ? 'Claude Code when it is ready, otherwise an API key you added, otherwise Ollama.' : r[p] ? '' : need[p];
    note.classList.toggle('bad', p !== 'auto' && !r[p]);
    $('ag-ollama-models').replaceChildren(...(env.ollamaModels || []).map((m) => new Option('', m.replace(/:latest$/, ''))));
    $('ag-voice-note').textContent = `Every agent speaks through ${ENGINES[env.engine] || env.engine}. Change the engine in Settings › Voice.`;
  }
  document.querySelectorAll('#a-edit [data-s]').forEach((f) => f.addEventListener('change', syncAgent));

  // The editor's tabs.
  document.querySelectorAll('#a-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#a-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('#a-edit .at').forEach((t) => { t.hidden = t.dataset.at !== b.dataset.at; });
  }));

  // Role: a custom one is written in the user's words.
  function syncRole() {
    const r = $('a-role').value;
    $('a-role-own').hidden = r !== 'custom';
    $('a-role-note').textContent = r === 'none' ? 'An all-rounder with no particular focus.' : '';
  }
  $('a-role').addEventListener('change', syncRole);

  // Quick commands: name and what it does.
  let cmds = [];
  function renderCmds() {
    $('a-cmd-count').textContent = cmds.length ? String(cmds.length) : '';
    $('a-cmds').replaceChildren(...cmds.map((c, i) => {
      const row = li();
      const n = Object.assign(document.createElement('input'), { className: 'key name', value: c.name, placeholder: 'standup', maxLength: 30 });
      const t = Object.assign(document.createElement('input'), { className: 'key', value: c.prompt, placeholder: 'What it should do', maxLength: 600 });
      n.addEventListener('input', () => { c.name = n.value; });
      t.addEventListener('input', () => { c.prompt = t.value; });
      const x = el('button', 'btn small', 'Remove');
      x.addEventListener('click', () => { cmds.splice(i, 1); renderCmds(); });
      row.append(n, t, x);
      return row;
    }));
  }
  $('a-cmd-add').addEventListener('click', () => { if (cmds.length < 20) { cmds.push({ name: '', prompt: '' }); renderCmds(); $('a-cmds').lastChild.querySelector('input').focus(); } });

  // Colour: '' is the theme's.
  let color = '';
  $('a-color').addEventListener('input', () => { color = $('a-color').value; paint($('a-face'), color); });
  $('a-color-reset').addEventListener('click', () => { color = ''; paint($('a-face'), ''); });

  // Guardrails: the safety level and the tools.
  let guard = 'standard';
  function renderGuard() {
    $('a-guard').replaceChildren(...Object.entries(catalog.guards).map(([k, g]) => {
      const b = el('button', 'level' + (k === guard ? ' on' : ''));
      b.append(el('b', '', g.label), el('small', '', g.about));
      b.addEventListener('click', () => { guard = k; renderGuard(); });
      return b;
    }));
  }
  function renderTools() {
    const ids = Object.keys(catalog.tools);
    $('a-tools').replaceChildren(...ids.map((k) => pickRow(!sel.tools || sel.tools.has(k), catalog.tools[k].label, catalog.tools[k].about, null, (on) => toggle('tools', ids, k, on))));
    $('a-tool-count').textContent = ids.length ? `${sel.tools ? sel.tools.size : ids.length} of ${ids.length} on` : '';
  }

  // Training: the facts only this agent keeps. Adding or forgetting one takes effect at once.
  function renderTraining(a) {
    const facts = a.memory || [];
    $('a-mem-count').textContent = facts.length ? String(facts.length) : '';
    $('a-mem').replaceChildren(...(facts.length ? facts.map((f) => {
      const row = li();
      row.append(span('ds wrap', f.text), span('src', String(f.added || '').slice(0, 10)));
      const x = el('button', 'btn small', 'Forget');
      x.addEventListener('click', () => post({ type: 'action', name: 'assistant-memory-forget', id: a.id, fact: f.id }));
      row.append(x);
      return row;
    }) : [Object.assign(li('empty'), { textContent: `Nothing yet. Teach ${a.name} something above.` })]));
  }
  const teach = () => {
    const v = $('a-mem-new').value.trim();
    if (!v) return;
    post({ type: 'action', name: 'assistant-memory-add', id: editing, text: v });
    $('a-mem-new').value = '';
  };
  $('a-mem-add').addEventListener('click', teach);
  $('a-mem-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') teach(); });

  // Try it: one reply from this agent, without switching.
  $('a-try-go').addEventListener('click', () => {
    const v = $('a-try-text').value.trim();
    if (!v) return;
    $('a-try-go').disabled = true;
    $('a-try-note').textContent = `${$('a-edit-title').textContent} is thinking…`;
    $('a-try-out').hidden = true;
    post({ type: 'action', name: 'assistant-try', id: editing, text: v });
  });
  function tried(e) {
    if (e.id !== editing) return;
    $('a-try-go').disabled = false;
    $('a-try-note').textContent = '';
    $('a-try-out').textContent = e.error || e.text;
    $('a-try-out').classList.toggle('bad', !!e.error);
    $('a-try-out').hidden = false;
  }
  $('a-maint').addEventListener('change', () => {
    const name = $('a-edit-title').textContent;
    if ($('a-maint').checked && !confirm(`Let ${name} change JARVIS's own code? Every change still goes through a pull request you merge.`)) $('a-maint').checked = false;
  });
  $('a-export').addEventListener('click', () => post({ type: 'action', name: 'assistant-export', id: editing }));
  $('a-import').addEventListener('click', () => { if (confirm('Import an agent from a file? Only import files you trust: its persona and role shape what it does, though the safety rules still apply.')) post({ type: 'action', name: 'assistant-import' }); });

  // ---------- skills and MCP servers ----------
  // ext: what main found on this Mac (Settings › Skills & MCP), sel: the open assistant's ticks
  // (null = all of them, so new skills are on by default).
  let ext = { skills: [], mcp: [], markets: [] };
  let sel = { id: '', skills: null, mcp: null };
  const li = (cls) => { const x = document.createElement('li'); if (cls) x.className = cls; return x; };
  const span = (cls, text) => { const x = document.createElement('span'); x.className = cls; x.textContent = text; return x; };
  const SRC = { personal: 'Yours', jarvis: 'GitHub', plugin: '' };
  function pickRow(on, name, desc, tag, onChange, title) {
    const row = li();
    const lab = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = on;
    box.addEventListener('change', () => onChange(box.checked));
    lab.append(box, span('nm', name), span('ds', desc));
    lab.title = title || desc;
    row.append(lab);
    if (tag) row.append(tag);
    return row;
  }
  function toggle(kind, ids, key, on) {
    if (!sel[kind]) sel[kind] = new Set(ids);
    if (on) sel[kind].add(key); else sel[kind].delete(key);
    if (sel[kind].size === ids.length) sel[kind] = null;
    renderPicks();
  }
  function renderPicks() {
    const find = $('a-skill-find').value.trim().toLowerCase();
    const ids = ext.skills.map((x) => x.id);
    const isOn = (k, key) => !sel[k] || sel[k].has(key);
    const shown = ext.skills.filter((x) => !find || (x.name + ' ' + x.description + ' ' + (x.plugin || '')).toLowerCase().includes(find));
    $('a-skills').replaceChildren(...(shown.length ? shown.map((x) => pickRow(isOn('skills', x.id), x.name, x.description, span('src', SRC[x.source] || String(x.plugin)), (on) => toggle('skills', ids, x.id, on))) : [Object.assign(li('empty'), { textContent: ext.skills.length ? 'No skill matches' : 'Looking for skills…' })]));
    $('a-skill-count').textContent = ext.skills.length ? `${sel.skills ? sel.skills.size : ext.skills.length} of ${ext.skills.length} on` : '';
    const names = ext.mcp.map((m) => m.name);
    $('a-mcp').replaceChildren(...(ext.mcp.length ? ext.mcp.map((m) => pickRow(isOn('mcp', m.name), m.name, m.target, span('st ' + m.status.split(' ')[0], cap(m.status)), (on) => toggle('mcp', names, m.name, on))) : [Object.assign(li('empty'), { textContent: 'Checking your MCP servers…' })]));
    $('a-mcp-count').textContent = ext.mcp.length ? `${sel.mcp ? sel.mcp.size : ext.mcp.length} of ${ext.mcp.length} on` : '';
    renderTools();
  }
  $('a-skill-find').addEventListener('input', renderPicks);
  $('a-skill-all').addEventListener('click', () => { sel.skills = null; renderPicks(); });
  $('a-skill-none').addEventListener('click', () => { sel.skills = new Set(); renderPicks(); });

  // Settings › Skills & MCP: what's here, and getting more.
  function xNote(text, bad) { for (const id of ['x-note', 'k-note']) { $(id).textContent = text || ''; $(id).classList.toggle('bad', !!bad); } }
  const busy = (text) => xNote(text);
  function setExt(e) {
    ext = { skills: e.skills || [], mcp: e.mcp || [], markets: e.markets || [] };
    if (e.error) xNote(e.error, true); else if (e.done) xNote(e.done);
    $('sc-ext').textContent = `${ext.mcp.length} servers and connectors`;
    $('sc-skills').textContent = `${ext.skills.length} on this Mac`;
    if (assistants.length) renderAssistantCards();
    renderPicks();
    renderSkillsPage();
    const ms = $('x-market'), keep = ms.value;
    ms.replaceChildren(...ext.markets.map((m) => new Option(`${m.name} (${m.plugins.length})`, m.name)));
    if (ext.markets.some((m) => m.name === keep)) ms.value = keep;
    renderPlugins();
    $('x-mcp').replaceChildren(...(ext.mcp.length ? ext.mcp.map((m) => {
      const row = li();
      row.append(span('nm', m.name), span('ds', m.target), span('st ' + m.status.split(' ')[0], cap(m.status)));
      if (m.status === 'needs sign-in') row.title = `Run "claude" in a terminal and type /mcp to sign in to ${m.name}.`;
      if (m.kind === 'server') {
        const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Remove';
        b.addEventListener('click', () => { if (confirm(`Remove the MCP server ${m.name} from your Claude Code?`)) { busy(`Removing ${m.name}…`); post({ type: 'action', name: 'ext:mcp-remove', server: m.name }); } });
        row.append(b);
      }
      return row;
    }) : [Object.assign(li('empty'), { textContent: 'Checking…' })]));
  }
  // Settings › Skills: every skill, which agents use it, and what it costs each turn. A tick changes that
  // agent straight away (null = all skills, so new ones are on by default).
  const tokens = (x) => Math.ceil((x.name.length + x.description.length) / 4) + 8;
  const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  function agentSkills(a) { return a.skills ? new Set(a.skills) : null; }
  function setAgentSkill(a, id, on) {
    const all = ext.skills.map((x) => x.id);
    const cur = agentSkills(a) || new Set(all);
    if (on) cur.add(id); else cur.delete(id);
    const list = [...cur].filter((x) => all.includes(x));
    a.skills = list.length === all.length ? null : list;
    if (sel.id === a.id) sel.skills = a.skills ? new Set(a.skills) : null;
    post({ type: 'action', name: 'assistant-update', id: a.id, skills: a.skills || 'all' });
    renderSkillsPage();
  }
  function renderSkillsPage() {
    const find = $('k-find').value.trim().toLowerCase(), src = $('k-src').value;
    $('k-cost').replaceChildren(...assistants.map((a) => {
      const on = agentSkills(a);
      const list = on ? ext.skills.filter((x) => on.has(x.id)) : ext.skills;
      const c = el('span', 'kc');
      paint(c, a.color);
      c.append(el('b', '', a.name), el('small', '', `${list.length} skills · ~${kfmt(list.reduce((n, x) => n + tokens(x), 0))} tokens a turn`));
      return c;
    }));
    const shown = ext.skills.filter((x) => (!src || x.source === src) && (!find || (x.name + ' ' + x.description + ' ' + (x.plugin || '')).toLowerCase().includes(find)));
    $('k-skills').replaceChildren(...(shown.length ? shown.map((x) => {
      const row = li();
      const top = el('div', 'krow');
      top.append(span('nm', x.name), span('src', SRC[x.source] || String(x.plugin)), span('src', `~${tokens(x)} tokens`));
      const who = el('div', 'kwho');
      for (const a of assistants) {
        const on = !agentSkills(a) || agentSkills(a).has(x.id);
        const b = el('button', 'kchip' + (on ? ' on' : ''), a.name);
        paint(b, a.color);
        b.title = `${on ? 'Turn off' : 'Turn on'} ${x.name} for ${a.name}`;
        b.addEventListener('click', () => setAgentSkill(a, x.id, !on));
        who.append(b);
      }
      if (x.source === 'jarvis') {
        const b = el('button', 'btn small', 'Remove');
        b.addEventListener('click', () => { if (confirm(`Remove the skill ${x.name}?`)) { busy(`Removing ${x.name}…`); post({ type: 'action', name: 'ext:skill-remove', id: x.id }); } });
        who.append(b);
      }
      const box = el('div', 'kbody');
      box.append(top, span('ds wrap', x.description), who);
      row.append(box);
      return row;
    }) : [Object.assign(li('empty'), { textContent: ext.skills.length ? 'No skill matches' : 'Looking for skills…' })]));
  }
  $('k-find').addEventListener('input', renderSkillsPage);
  $('k-src').addEventListener('change', renderSkillsPage);

  function renderPlugins() {
    const m = ext.markets.find((x) => x.name === $('x-market').value);
    const find = $('x-find').value.trim().toLowerCase();
    const list = m ? m.plugins.filter((p) => !find || (p.name + ' ' + p.description + ' ' + p.category).toLowerCase().includes(find)) : [];
    $('x-plugins').replaceChildren(...(list.length ? list.slice(0, 80).map((p) => {
      const row = li();
      row.append(span('nm', p.name), span('ds', p.description));
      row.title = p.description;
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = p.installed ? 'Remove' : 'Install';
      b.addEventListener('click', () => {
        if (p.installed) { if (!confirm(`Remove ${p.name} from your Claude Code?`)) return; busy(`Removing ${p.name}…`); post({ type: 'action', name: 'ext:uninstall', plugin: p.name, market: m.name }); return; }
        if (!confirm(`Install ${p.name} from ${m.name}${m.from ? ` (${m.from})` : ''}? Its skills run with the same access as JARVIS, so only install what you trust.`)) return;
        busy(`Installing ${p.name}…`);
        post({ type: 'action', name: 'ext:install', plugin: p.name, market: m.name });
      });
      row.append(b);
      return row;
    }) : [Object.assign(li('empty'), { textContent: m ? 'No plugin matches' : 'No marketplace yet' })]));
  }
  $('x-market').addEventListener('change', renderPlugins);
  $('x-find').addEventListener('input', renderPlugins);
  $('x-check').addEventListener('click', () => { busy('Checking your MCP servers…'); post({ type: 'action', name: 'ext:check' }); });
  $('x-gh-add').addEventListener('click', () => {
    const repo = $('x-gh').value.trim();
    if (!repo) return;
    if (!confirm(`Add the skills from github.com/${repo.replace(/^https:\/\/github\.com\//, '')}? They run with the same access as JARVIS, so only add what you trust.`)) return;
    busy(`Fetching ${repo}…`);
    post({ type: 'action', name: 'ext:github', repo });
  });
  $('x-market-add').addEventListener('click', () => {
    const source = $('x-market-src').value.trim();
    if (!source) return;
    busy(`Adding ${source}…`);
    post({ type: 'action', name: 'ext:market', source });
  });
  $('x-mcp-add').addEventListener('click', () => {
    const server = $('x-mcp-name').value.trim(), target = $('x-mcp-target').value.trim();
    if (!server || !target) { xNote('Give the server a name and its address or command.', true); return; }
    if (!confirm(`Add the MCP server ${server} (${target}) to your Claude Code? It can do anything JARVIS can, so only add one you trust.`)) return;
    busy(`Adding ${server}…`);
    post({ type: 'action', name: 'ext:mcp-add', server, target });
  });
  function aNote(text, bad) { $('a-note').textContent = text || ''; $('a-note').classList.toggle('bad', !!bad); }
  $('a-save').addEventListener('click', () => {
    const a = assistants.find((x) => x.id === editing);
    if (!a) return;
    const settings = {};
    document.querySelectorAll('#a-edit [data-s]').forEach((f) => { if (f.value !== '') settings[f.dataset.s] = f.type === 'number' ? Number(f.value) : f.value.trim(); });
    const patch = {
      id: a.id, persona: $('a-persona').value, wakeWords: $('a-wake').value, settings,
      role: $('a-role').value, roleText: $('a-role-text').value, commands: cmds.filter((c) => c.name.trim() && c.prompt.trim()),
      color, sharedMemory: $('a-shared').checked, guard, blockedPaths: $('a-blocked').value.split('\n'), maintainer: $('a-maint').checked,
      tools: sel.id === a.id && sel.tools ? [...sel.tools] : 'all',
    };
    if (sel.id === a.id && ext.skills.length) patch.skills = sel.skills ? [...sel.skills] : 'all';
    if (sel.id === a.id && ext.mcp.length) patch.mcp = sel.mcp ? [...sel.mcp] : 'all';
    if (a.custom) Object.assign(patch, { title: $('a-name').value, tier: $('a-tier').value, about: $('a-about').value });
    aNote(`Saving ${a.name}…`);
    post({ type: 'action', name: 'assistant-update', ...patch });
  });
  $('a-use').addEventListener('click', () => { aNote(`Switching to ${$('a-edit-title').textContent}…`); post({ type: 'action', name: 'assistant', id: editing }); });
  $('a-reset').addEventListener('click', () => { if (confirm('Forget your changes to this agent and go back to its preset?')) post({ type: 'action', name: 'assistant-reset', id: editing }); });
  $('a-delete').addEventListener('click', () => { if (confirm(`Delete ${$('a-edit-title').textContent}? Its settings go too. Memory stays.`)) post({ type: 'action', name: 'assistant-delete', id: editing }); });
  $('a-create').addEventListener('click', () => {
    const name = $('a-new-name').value.trim();
    if (!name) { aNote('Type a name for the new agent first.', true); return; }
    post({ type: 'action', name: 'assistant-create', from: $('a-new-from').value, title: name });
    $('a-new-name').value = '';
  });

  // ---------- spotlight: another assistant comes forward, to switch to ----------
  // Clicking one brings it to the centre while the core steps back; SWITCH makes it the one in use.
  let spotted = '';
  function spot(id) {
    const h = HUBS.find((x) => x.id === id);
    if (!h) return;
    if (body.dataset.view !== 'cc') showView('cc');
    spotted = id;
    body.classList.remove('focus');
    body.classList.add('spot');
    HUBS.forEach((x) => $('crew-' + x.id).classList.toggle('spot', x.id === id));
    $('spot-name').textContent = h.name;
    $('spot-role').textContent = `${h.role} · ${h.about}`;
    // Say so up front when its brain isn't set up here (main checks again when SWITCH is pressed).
    const st = ((assistants.find((x) => x.id === id) || {}).settings) || {};
    const notHere = st.brainProvider && st.brainProvider !== 'auto' && env.ready && env.ready[st.brainProvider] === false;
    const where = machine ? ` ON ${machineName(machine).toUpperCase()}` : ' ON THIS MAC';
    $('spot-hint').textContent = notHere ? `NEEDS ${String(h.needs).toUpperCase()}, NOT SET UP${where} · SETTINGS › BRAINS & KEYS` : `NEEDS ${String(h.needs).toUpperCase()} · SAME MEMORY AND CONVERSATION`;
    $('spot-hint').classList.toggle('bad', !!notHere);
    $('spot-go').textContent = `SWITCH TO ${h.name}`;
    $('spot-go').disabled = false;
    $('spot-go').hidden = false;
    $('spot-pair').hidden = true;
    $('spot-make').hidden = true;
    $('spot').hidden = false;
  }

  // Pairing, right on the HUD: the + PAIR node comes forward with a code to show or one to type.
  function spotPair() {
    const h = HUBS.find((x) => x.group === 'pair');
    if (body.dataset.view !== 'cc') showView('cc');
    spotted = h ? h.id : 'g-pair';
    body.classList.remove('focus');
    body.classList.add('spot');
    HUBS.forEach((x) => $('crew-' + x.id).classList.toggle('spot', x.id === spotted));
    $('spot-name').textContent = 'PAIR';
    $('spot-role').textContent = 'Connect another computer running JARVIS. Show a code here and type it there, or type the one it shows. Both need JARVIS open and internet.';
    pairHint('');
    $('spot-code').textContent = '';
    $('spot-code').hidden = true;
    $('sp-host').hidden = false;
    $('sp-code').value = '';
    $('spot-go').hidden = true;
    $('spot-make').hidden = true;
    $('spot-pair').hidden = false;
    $('spot').hidden = false;
  }
  // Making a custom agent, right on the HUD: a name, then its page in the Agents tab.
  let making = false;
  function spotMake() {
    const h = HUBS.find((x) => x.group === 'create');
    if (body.dataset.view !== 'cc') showView('cc');
    spotted = h ? h.id : 'g-create';
    body.classList.remove('focus');
    body.classList.add('spot');
    HUBS.forEach((x) => $('crew-' + x.id).classList.toggle('spot', x.id === spotted));
    $('spot-name').textContent = 'FORGE';
    $('spot-role').textContent = machine ? `Make a new agent on ${machineName(machine)}. Give it a name, then set its role, brain, voice and guardrails.` : 'Make an agent of your own. Give it a name, then set its role, brain, voice and guardrails.';
    pairHint('');
    $('sm-name').value = '';
    $('spot-go').hidden = true;
    $('spot-pair').hidden = true;
    $('spot-make').hidden = false;
    $('spot').hidden = false;
    setTimeout(() => $('sm-name').focus(), 400);
  }
  const makeAgent = () => {
    const name = $('sm-name').value.trim();
    if (!name) return;
    making = true;
    pairHint('MAKING IT…');
    post({ type: 'action', name: 'assistant-create', from: 'blank', title: name });
  };
  $('spot-make').addEventListener('click', (ev) => ev.stopPropagation());
  $('sm-go').addEventListener('click', makeAgent);
  $('sm-name').addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') makeAgent(); if (ev.key === 'Escape') unspot(); });

  function pairHint(text, bad) { $('spot-hint').textContent = text; $('spot-hint').classList.toggle('bad', !!bad); }
  /** Main's news about a pairing, while the + PAIR node is in the spotlight. */
  function pairNews(e) {
    if ($('spot-pair').hidden || !spotted) return;
    if (e.error) { pairHint(e.error.toUpperCase(), true); return; }
    const p = e.pair;
    if (!p) return;
    if (p.state === 'waiting' && p.code) { $('spot-code').textContent = p.code; $('spot-code').hidden = false; $('sp-host').hidden = true; pairHint(`TYPE IT ON THE OTHER COMPUTER · GOOD FOR ${p.minutes} MINUTES`); }
    else if (p.state === 'waiting') pairHint('LOOKING FOR THE OTHER COMPUTER…');
    else if (p.state === 'slow') pairHint(p.role === 'host' ? 'NO SIGN OF IT YET · TYPE THE CODE ON THE OTHER COMPUTER, IN JARVIS' : 'CAN\'T FIND IT YET · CHECK THE CODE IS STILL SHOWING ON THE OTHER COMPUTER', true);
    else if (p.state === 'expired') { pairHint('THE CODE RAN OUT · SHOW A NEW ONE', true); $('spot-code').hidden = true; $('sp-host').hidden = false; }
    else if (p.state === 'paired') {
      pairHint(`PAIRED WITH ${String(p.name).toUpperCase()}`);
      $('spot-code').hidden = true;
      setTimeout(() => { if (!$('spot-pair').hidden) { unspot(); openGroup('devices'); } }, 1600);
    }
  }
  $('spot-pair').addEventListener('click', (ev) => ev.stopPropagation());
  $('sp-host').addEventListener('click', () => { pairHint('GETTING A CODE…'); postLocal({ type: 'action', name: 'dev:host' }); });
  const joinPair = () => { const code = $('sp-code').value.trim(); if (!code) return; pairHint('LOOKING FOR THE OTHER COMPUTER…'); postLocal({ type: 'action', name: 'dev:join', code }); };
  $('sp-join').addEventListener('click', joinPair);
  $('sp-code').addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') joinPair(); if (ev.key === 'Escape') unspot(); });
  function unspot() {
    if (!spotted) return;
    // Backing out of a pairing that's still going ends it.
    if (!$('spot-pair').hidden) { postLocal({ type: 'action', name: 'dev:cancel' }); $('spot-pair').hidden = true; }
    $('spot-make').hidden = true;
    spotted = '';
    body.classList.remove('spot');
    HUBS.forEach((x) => $('crew-' + x.id).classList.remove('spot'));
    $('spot').hidden = true;
    armFocus();
  }
  /** The name in the core: the agent in use, or the group that is open (MESH, FORGE, a computer). */
  function coreLabel() {
    const me = assistants.find((a) => a.id === current) || assistants[0];
    const dm = /^(device|dcustom):(.+)$/.exec(crewGroup);
    const name = crewGroup === 'devices' ? 'MESH' : crewGroup === 'custom' || (dm && dm[1] === 'dcustom') ? 'FORGE' : dm ? machineName(dm[2]).toUpperCase() : me ? me.name : 'JARVIS';
    document.querySelector('.corelabel .jv').textContent = name;
    body.classList.toggle('grouped', crewGroup !== 'main');
  }
  let openedFrom = null;   // set by a click: where the burst starts (the core, once the node got there)
  const f2 = (n) => Number(n).toFixed(2);
  /** Open a group node: its members burst out of it. */
  function openGroup(group) {
    if (group === 'pair') { spotPair(); return; }
    if (group === 'create') { spotMake(); return; }
    // A computer whose agents haven't arrived (it isn't reachable): open its tab, with its last state.
    const dm = /^device:(.+)$/.exec(group);
    if (dm && !remoteDevices().some((d) => d.id === dm[1])) { showMachine(dm[1]); return; }
    // The node that was clicked, where it shows now: the burst starts there.
    const from = HUBS.find((x) => x.group === group || (group === 'main' && x.group === 'main')) || null;
    const full = body.classList.contains('focus') || body.classList.contains('spot');
    burstFrom = openedFrom || (from ? (full ? { x: from.x, y: from.y } : { x: from.nx, y: from.ny }) : { x: 0, y: 0 });
    openedFrom = null;
    if (spotted) unspot();
    crewGroup = group;
    popping = true;
    HUBS = hubsFor();
    crew.innerHTML = buildCrew();
    popping = false;
    coreLabel();
  }
  crew.addEventListener('click', (ev) => {
    const m = ev.target.closest('.mate');
    if (!m) return;
    ev.stopPropagation();
    const h = HUBS.find((x) => x.id === m.dataset.id);
    if (!h) return;
    if (h.group) {
      // Like choosing an agent, the node flies to the core; then it bursts into its members.
      if (crew.classList.contains('swap')) return;
      const full = body.classList.contains('focus') || body.classList.contains('spot');
      m.style.setProperty('--gx', f2(-(full ? h.x : h.nx)));
      m.style.setProperty('--gy', f2(-(full ? h.y : h.ny)));
      m.classList.add('gather');
      crew.classList.add('swap');
      setTimeout(() => { crew.classList.remove('swap'); openedFrom = { x: 0, y: 0 }; openGroup(h.group); }, 600);
      return;
    }
    // Another device's agent: open its tab, with that agent in the spotlight.
    if (h.device) { const dev = h.device, a = h.agent; showMachine(dev); const ag = assistants.find((x) => x.id === a); crewGroup = ag && ag.custom ? 'custom' : 'main'; HUBS = hubsFor(); crew.innerHTML = buildCrew(); coreLabel(); spot(a); return; }
    if (m.dataset.id === spotted) return;
    spot(m.dataset.id);
  });
  $('spot-back').addEventListener('click', (ev) => { ev.stopPropagation(); unspot(); });
  $('spot-go').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!spotted) return;
    $('spot-go').disabled = true;
    $('spot-hint').textContent = 'SWITCHING…';
    post({ type: 'action', name: 'assistant', id: spotted });
  });

  // ---------- animation loop ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  let last = performance.now(), spinA = 0, tAcc = 0, nextBolt = 1.5;
  const tmp = new THREE.Color();

  // 30 frames a second while something is happening, 20 at rest (the scene barely moves then), 4 on
  // the other tabs, and none while the window is hidden. Full rate cost most of a CPU core.
  const BUSY_MS = 1000 / 30, REST_MS = 1000 / 20, AWAY_MS = 250;
  document.addEventListener('visibilitychange', () => body.classList.toggle('asleep', document.hidden));
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const calm = boot.assembled && (state === 'idle' || state === 'muted') && flash === 0 && !spotted;
    const gap = body.dataset.view !== 'cc' ? AWAY_MS : calm ? REST_MS : BUSY_MS;
    if (now - last < gap - 2) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; tAcc += dt;
    const tgt = STATES[state] || STATES.idle;
    const k = 1 - Math.pow(0.001, dt);
    cur.color.lerp(tgt.color, k * 0.9);
    cur.spin = lerp(cur.spin, tgt.spin, k); cur.ringSpin = lerp(cur.ringSpin, tgt.ringSpin, k);
    cur.ringScale = lerp(cur.ringScale, tgt.ringScale + (state === 'listening' ? micLevel * 0.12 : 0) + (conversation && state === 'idle' ? 0.05 : 0), k);
    cur.jitter = lerp(cur.jitter, tgt.jitter + (state === 'listening' ? micLevel * 0.05 : 0), k);
    cur.core = lerp(cur.core, tgt.core, k); cur.opacity = lerp(cur.opacity, tgt.opacity, k); cur.breathe = lerp(cur.breathe, tgt.breathe, k);
    flash = Math.max(0, flash - dt * 2.2);
    micLevel *= 0.92; voiceLevel *= 0.9;

    if (!boot.assembled) {
      boot.t += dt;
      const p = Math.min(1, boot.t / 2.2), e = 1 - Math.pow(1 - p, 3);
      for (let i = 0; i < N * 3; i++) pos[i] = lerp(start[i], target[i], e);
      pgeo.attributes.position.needsUpdate = true;
      [...arcs, ...tilted, dial, dotted].forEach((g) => g.scale.setScalar(lerp(g.userData.startScale, 1, e)));
      if (p >= 1) boot.assembled = true;
    } else if (cur.jitter > 0.001) {
      const j = cur.jitter;
      for (let i = 0; i < N * 3; i++) pos[i] = target[i] + (Math.random() - 0.5) * j;
      pgeo.attributes.position.needsUpdate = true;
    } else if (pgeo.userData.dirty !== false) {
      pos.set(target); pgeo.attributes.position.needsUpdate = true; pgeo.userData.dirty = false;
    }
    if (cur.jitter > 0.001) pgeo.userData.dirty = true;

    spinA += dt * cur.spin;
    particles.rotation.y = spinA; particles.rotation.x = Math.sin(tAcc * 0.3) * 0.25;
    globe.rotation.y = spinA * 0.6; globe.rotation.x = 0.35 + Math.sin(tAcc * 0.2) * 0.1;
    ico.rotation.y = -spinA * 1.4; ico.rotation.x = tAcc * 0.5;
    const breathe = 1 + Math.sin(tAcc * 1.6) * cur.breathe;
    const amp = state === 'speaking' ? voiceLevel * 0.22 : 0;
    const s = (breathe + amp) * (1 + flash * 0.08);
    particles.scale.setScalar(s); globe.scale.setScalar(s);
    glow.scale.setScalar((1.5 + amp * 2.2 + flash * 0.5) * cur.core);
    core.scale.setScalar((0.3 + amp * 0.5 + flash * 0.25) * cur.core);
    ico.scale.setScalar(0.95 + amp * 0.6);
    arcs.forEach((g, i) => { if (boot.assembled) { g.rotation.z += dt * cur.ringSpin * g.userData.speed * 3; g.scale.setScalar(cur.ringScale * (1 + flash * 0.12 * (i % 2 ? -1 : 1))); } });
    tilted.forEach((g) => { if (boot.assembled) { g.rotation.z += dt * g.userData.speed * (0.6 + Math.abs(cur.ringSpin)); g.scale.setScalar(cur.ringScale); } });
    if (boot.assembled) { dial.rotation.z -= dt * 0.08; dial.scale.setScalar(cur.ringScale * (1 + flash * 0.05)); dotted.rotation.z += dt * 0.05; dotted.scale.setScalar(cur.ringScale); }
    sweep.rotation.z += dt * (0.9 + Math.abs(cur.ringSpin) * 0.4);
    for (let i = 0; i < SAT; i++) {
      const o = satOrb[i]; o.a += dt * o.s * (0.6 + Math.abs(cur.ringSpin) * 0.4);
      const rr = o.r * cur.ringScale * (boot.assembled ? 1 : 2.5);
      satPos[i * 3] = Math.cos(o.a) * rr; satPos[i * 3 + 1] = Math.sin(o.a) * rr * Math.cos(o.tilt); satPos[i * 3 + 2] = Math.sin(o.a) * rr * Math.sin(o.tilt);
    }
    satGeo.attributes.position.needsUpdate = true;

    pmat.color.copy(cur.color); pmat.opacity = cur.opacity;
    globeMat.color.copy(cur.color); globeMat.opacity = 0.16 * cur.opacity;
    glowMat.color.copy(cur.color); glowMat.opacity = 0.45 * cur.opacity + flash * 0.4;
    haloMat.color.copy(cur.color); haloMat.opacity = (0.26 + amp * 0.5 + flash * 0.3) * cur.opacity; halo.scale.setScalar(R * 2.56 * cur.ringScale * (1 + amp * 0.15));
    halo2Mat.color.copy(cur.color); halo2Mat.opacity = (0.32 + flash * 0.3) * cur.opacity; halo2.scale.setScalar(2.36 * cur.ringScale);
    icoMat.color.copy(cur.color); icoMat.opacity = 0.4 * cur.opacity;
    satMat.color.copy(cur.color).lerp(COL.white, 0.5); satMat.opacity = 0.9 * cur.opacity;
    tmp.copy(cur.color).lerp(COL.white, 0.25);
    ringMats.forEach((m) => { m.color.copy(tmp); });
    sweep.material.color.copy(COL.white);
    const ringOp = cur.opacity * (1 + flash * 0.6);
    arcs.forEach((g) => g.children.forEach((c) => { c.material.opacity = Math.min(1, (c.material.userData.base || (c.material.userData.base = c.material.opacity)) * ringOp); }));

    nextBolt -= dt;
    const boltRate = state === 'thinking' ? 0.25 : state === 'speaking' ? 0.5 + (1 - voiceLevel) : state === 'listening' ? 1.2 : 2.5;
    if (boot.assembled && state !== 'muted' && nextBolt <= 0) { fireBolt(); nextBolt = boltRate * (0.5 + Math.random()); }
    bolts.forEach((b) => { if (b.userData.life > 0) { b.userData.life -= dt * 7; b.material.opacity = Math.max(0, b.userData.life) * 0.8; b.material.color.copy(cur.color).lerp(COL.white, 0.6); } });

    const lvl = state === 'speaking' ? voiceLevel : state === 'listening' ? micLevel : state === 'thinking' ? 0.25 + Math.sin(tAcc * 6) * 0.15 : 0.05;
    drawWave(bars, lvl, 22, tAcc);

    if (body.dataset.view === 'cc') renderer.render(scene, camera);
  }
  function drawWave(arr, lvl, maxH, t) {
    for (let i = 0; i < arr.length; i++) {
      const c = Math.abs(i - arr.length / 2) / (arr.length / 2);
      const v = Math.max(0.1, lvl * (1 - c * c) * (0.55 + 0.45 * Math.abs(Math.sin(t * 9 + i * 0.7))));
      arr[i].style.transform = `scaleY(${((2 + v * maxH) / 24).toFixed(3)})`;
    }
  }
  function makeBars(el, n) { const out = []; for (let i = 0; i < n; i++) { const b = document.createElement('i'); el.appendChild(b); out.push(b); } return out; }
  const bars = makeBars($('wave'), 64);

  // ---------- views (top-left chips) ----------
  function showView(v) {
    body.dataset.view = v;
    document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (v === 'cc') resize();
    if (v === 'history') { const c = $('chat'); c.scrollTop = c.scrollHeight; }
    if ((v === 'agents' && !machine) || v === 'settings') post({ type: 'action', name: 'ext:list' });   // the skills and servers to tick
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', () => showView(a.dataset.view)));
  if (location.hash.length > 1 && document.getElementById('v-' + location.hash.slice(1))) setTimeout(() => showView(location.hash.slice(1)), 4500);

  // ---------- state ----------
  const STATE_LABEL = { booting: 'BOOTING', idle: 'IDLE', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', error: 'ERROR', muted: 'STANDBY' };
  function setState(s) {
    if (!STATES[s]) return;
    const moved = s !== state;
    if (moved) flash = 1;
    state = s;
    body.dataset.state = s;
    const label = disabled ? 'DISABLED' : (s === 'idle' ? (conversation ? 'AWAKE' : 'ASLEEP') : (STATE_LABEL[s] || s.toUpperCase()));
    $('st-state').textContent = label; $('r-state').textContent = label;
    $('brand2').textContent = 'HOME · ' + (SYS_WORD[s] || s.toUpperCase());
    $('power').querySelector('b').textContent = `${disabled ? 'ENABLE' : 'DISABLE'} ${(assistants.find((a) => a.id === current) || assistants[0]).name}`; $('power').classList.toggle('off', disabled); document.body.classList.toggle('disabled', disabled);
    $('mic').classList.toggle('off', s === 'muted' || disabled); $('mic').title = s === 'muted' ? 'Microphone off — click to unmute' : 'Microphone on — click to mute';
    if (s !== 'booting') bootSignal();
    if (moved) armCaptions();
  }
  let disabled = false;

  // Captions clear themselves: new speech replaces the old pair, and both fade after a quiet spell.
  const CAPTION_MS = 8000;
  let captionTimer = 0;
  function armCaptions() {
    clearTimeout(captionTimer);
    $('status').classList.remove('quiet');
    if (state === 'speaking' || state === 'thinking') return;
    captionTimer = setTimeout(() => {
      $('status').classList.add('quiet');
      captionTimer = setTimeout(() => {
        $('transcript').textContent = ''; $('reply').textContent = ''; $('reply').className = '';
        $('status').classList.remove('quiet');
      }, 600);
    }, CAPTION_MS);
  }
  function setMode(m) {
    if (m && 'disabled' in m) disabled = !!m.disabled;
    if (m && 'conversation' in m) conversation = !!m.conversation;
    $('convtag').hidden = !conversation;
    setState(state);
  }
  function tick() {
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    $('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    $('date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase();
  }
  setInterval(tick, 1000); tick();

  // ---------- tools ----------
  function toolHint(name, summary) {
    const s = summary || '';
    if (name === 'Agent' || name === 'Task') return (s.replace(/^agent:\s*/, '') || 'on it') + '…';
    if (name === 'Bash') {
      if (/sessions\.sh|terminals\.sh/.test(s)) return 'scanning sessions…';
      if (/send\.sh/.test(s)) return 'typing into a session…';
      if (/read\.sh/.test(s)) return 'reading a transcript…';
      if (/mac\.sh screenshot/.test(s)) return 'taking a screenshot…';
      if (/mac\.sh/.test(s)) return 'mac control…';
      if (/^open /.test(s)) { const url = (s.match(/https?:\/\/([^\s/"']+)/) || [])[1]; const app = (s.match(/-a\s+"?([^"\s]+)/) || [])[1]; return 'opening ' + (url || app || 'app') + '…'; }
      return 'running a command…';
    }
    if (name === 'Read') return 'reading ' + (s.split('/').pop() || 'a file') + '…';
    if (name === 'WebSearch') return 'searching the web…';
    if (name === 'WebFetch') return 'fetching a page…';
    if (name === 'Glob' || name === 'Grep') return 'searching files…';
    return name.toLowerCase() + '…';
  }
  function addTool(name, summary) {
    stats.toolCalls++;
    const r = $('reply');
    if (state === 'thinking' && (!r.textContent || r.classList.contains('hint'))) { r.textContent = toolHint(name, summary); r.className = 'hint'; }
  }

  // ---------- sessions (Sessions view cards + live picker source) ----------
  const SESS_ICON = ['</>', '◎', '▤', '⚒', '◍', '✓'];
  let sessTab = null, sessData = [], watchedCwd = null;
  function sessKind(s) { return s.kind === 'jarvis' ? 'jarvis' : 'claude'; }
  function renderSessions() {
    const jarvis = sessData.filter((s) => sessKind(s) === 'jarvis'), claude = sessData.filter((s) => sessKind(s) === 'claude');
    if (sessTab === null && sessData.length) sessTab = jarvis.length ? 'jarvis' : 'claude';
    const tabNow = sessTab || 'jarvis';
    document.querySelectorAll('[data-tabs] button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tabNow);
      b.querySelector('i').textContent = b.dataset.tab === 'jarvis' ? jarvis.length : claude.length;
    });
    const list = (tabNow === 'jarvis' ? jarvis : claude).slice().sort((a, b) => (b.modified || 0) - (a.modified || 0));
    document.querySelectorAll('[data-cards]').forEach((cards) => {
      const max = +cards.dataset.max || 6;
      cards.textContent = '';
      const arr = list.slice(0, max);
      if (!arr.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = tabNow === 'jarvis' ? 'NO JARVIS SESSIONS' : 'NO CLAUDE CODE SESSIONS'; cards.appendChild(e); }
      arr.forEach((s, idx) => {
        const card = document.createElement('div'); card.className = 'card ' + (s.status || 'idle'); card.dataset.cwd = s.cwd || '';
        const ico = document.createElement('i'); ico.className = 'ico'; ico.textContent = sessKind(s) === 'jarvis' ? '◆' : SESS_ICON[idx % SESS_ICON.length];
        const bodyEl = document.createElement('div'); bodyEl.className = 'body';
        const name = document.createElement('div'); name.className = 'name';
        const dot = document.createElement('span'); dot.className = 'dot ' + (s.status || '');
        const nm = document.createElement('span'); nm.textContent = s.name || s.cwd || '?'; nm.title = s.cwd || '';
        name.appendChild(dot); name.appendChild(nm);
        const meta = document.createElement('div'); meta.className = 'meta';
        meta.textContent = ((s.status || 'idle') + ' · ' + (s.ago || '') + (s.terminal ? ' · ' + (s.terminal.tty || s.terminal.title || '') : '')).toUpperCase();
        bodyEl.appendChild(name); bodyEl.appendChild(meta);
        if (s.cwd) { const cwd = document.createElement('div'); cwd.className = 'cwd'; cwd.textContent = s.cwd; bodyEl.appendChild(cwd); }
        const lastEl = document.createElement('div'); lastEl.className = 'last'; lastEl.textContent = s.last || ''; lastEl.title = s.last || '';
        bodyEl.appendChild(lastEl);
        const spark = document.createElement('div'); spark.className = 'spark';
        for (let i = 0; i < 12; i++) { const b = document.createElement('i'); b.style.height = (20 + ((idx * 7 + i * 13) % 70)) + '%'; spark.appendChild(b); }
        bodyEl.appendChild(spark);
        const isBrain = sessKind(s) === 'jarvis' && /brain/i.test(s.name || '');
        const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = isBrain ? 'RESET' : '×'; x.title = isBrain ? 'Start a new conversation' : 'Close this session';
        let armedT = null;
        x.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (armedT) { clearTimeout(armedT); armedT = null; x.classList.remove('confirm'); post({ type: 'action', name: 'close-session', id: s.id, cwd: s.cwd, kind: sessKind(s), name: s.name }); x.textContent = isBrain ? 'RESETTING…' : 'CLOSING…'; x.disabled = true; return; }
          x.classList.add('confirm'); x.textContent = isBrain ? 'RESET?' : 'CLOSE?';
          armedT = setTimeout(() => { armedT = null; x.classList.remove('confirm'); x.textContent = isBrain ? 'RESET' : '×'; }, 3000);
        });
        if (watchedCwd && s.cwd === watchedCwd) card.classList.add('watching');
        card.addEventListener('click', () => { if (sessKind(s) === 'jarvis') post({ type: 'action', name: 'watch', key: 'jarvis' }); else if (s.cwd) post({ type: 'action', name: 'watch', key: 'cc:' + s.cwd }); });
        card.appendChild(ico); card.appendChild(bodyEl); card.appendChild(x); cards.appendChild(card);
      });
    });
  }
  function setSessions(list) {
    sessData = Array.isArray(list) ? list.slice() : [];
    const active = sessData.filter((s) => s.status === 'working').length;
    stats.sessionsActive = active;
    document.querySelectorAll('[data-sesscount]').forEach((e) => { e.textContent = active + ' running · ' + sessData.length + ' total'; });
    $('n-sessions').textContent = sessData.length;
    $('r-sessions').textContent = active + ' RUNNING';
    $('br-work').textContent = active + ' SESSION' + (active === 1 ? '' : 'S') + ' WORKING';
    renderSessions();
  }
  document.querySelectorAll('[data-tabs] button').forEach((b) => b.addEventListener('click', () => { sessTab = b.dataset.tab; renderSessions(); }));
  renderSessions();

  const unmd = (t) => String(t || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\*\*/g, '');
  // ---------- right panel: conversations (JARVIS, background jobs, Claude Code sessions) ----------
  const livelog = $('livelog');
  let liveStuck = true, liveNow = null, liveSig = '';
  livelog.addEventListener('scroll', () => { liveStuck = livelog.scrollHeight - livelog.scrollTop - livelog.clientHeight < 24; });
  function setConversation(c) {
    if (!c || !c.entries) return;
    liveNow = c;
    $('live-name').textContent = c.name || '—';
    $('live-dot').className = 'dot ' + (c.status || '');
    $('live-ago').textContent = c.ago || '';
    $('live-pin').textContent = '';
    watchedCwd = c.key.startsWith('cc:') ? c.key.slice(3) : null;
    document.querySelectorAll('.card').forEach((el) => el.classList.toggle('watching', !!watchedCwd && el.dataset.cwd === watchedCwd));
    if (!livePop.hidden) buildPicker();
    const sig = c.key + JSON.stringify(c.entries);
    if (sig === liveSig) return;
    const switched = !liveSig.startsWith(c.key + '[');
    liveSig = sig;
    livelog.textContent = '';
    if (!c.entries.length) {
      const e = document.createElement('li'); e.className = 'empty';
      e.textContent = c.key === 'jarvis' ? 'NO CONVERSATION YET' : c.key.startsWith('cc:') ? 'NO MESSAGES YET' : 'NO BACKGROUND JOBS YET';
      livelog.appendChild(e); return;
    }
    c.entries.forEach((en) => {
      const li = document.createElement('li'); li.className = 'msg ' + (en.who || '');
      const head = document.createElement('div'); head.className = 'mh';
      const k = document.createElement('span'); k.className = 'k'; k.textContent = en.name || '';
      const tt = document.createElement('span'); tt.className = 't'; tt.textContent = en.t || '';
      head.appendChild(k); head.appendChild(tt);
      const x = document.createElement('div'); x.className = 'x'; x.textContent = unmd(en.text);
      x.addEventListener('click', () => li.classList.toggle('open'));
      li.appendChild(head); li.appendChild(x); livelog.appendChild(li);
    });
    if (liveStuck || switched) livelog.scrollTop = livelog.scrollHeight;
  }
  const livePop = $('live-pop'), liveBtn = $('live-btn');
  function buildPicker() {
    livePop.textContent = '';
    const add = (label, status, key, sub) => {
      const b = document.createElement('button');
      const d = document.createElement('span'); d.className = 'dot ' + (status || '');
      const n = document.createElement('span'); n.textContent = label;
      b.appendChild(d); b.appendChild(n);
      if (sub) { const sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
      b.classList.toggle('on', !!liveNow && liveNow.key === key);
      b.addEventListener('click', () => { post({ type: 'action', name: 'watch', key }); livePop.hidden = true; });
      livePop.appendChild(b);
    };
    const grp = (t) => { const g = document.createElement('div'); g.className = 'grp'; g.textContent = t; livePop.appendChild(g); };
    const jobs = (liveNow && liveNow.jobs) || 0;
    const me = (assistants.find((a) => a.id === current) || assistants[0]).name;
    grp(me);
    add(me, stats.brainReady ? 'idle' : '', 'jarvis', `you and ${me}`);
    add('BACKGROUND JOBS', jobs ? 'working' : 'idle', 'jobs', jobs ? `${jobs} running` : 'what JARVIS did for you');
    const claude = sessData.filter((x) => sessKind(x) === 'claude');
    if (claude.length) { grp('CLAUDE CODE'); claude.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((x) => add(x.name, x.status, 'cc:' + x.cwd, x.ago)); }
  }
  liveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); if (livePop.hidden) buildPicker(); livePop.hidden = !livePop.hidden; });
  document.addEventListener('click', (ev) => { if (!livePop.hidden && !livePop.contains(ev.target)) livePop.hidden = true; });

  // ---------- memory and schedule ----------
  function memRow(text, meta, onRemove, title) {
    const li = document.createElement('li');
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = text;
    const m = document.createElement('span'); m.className = 'meta'; m.textContent = meta;
    const x = document.createElement('button'); x.className = 'x'; x.title = title; x.textContent = '×'; x.addEventListener('click', onRemove);
    li.append(tx, m, x);
    return li;
  }
  function emptyRow(t) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t; return li; }
  function setMemory(facts) {
    facts = Array.isArray(facts) ? facts : [];
    const ul = $('mem-list');
    ul.replaceChildren(...(facts.length ? [...facts].reverse().map((f) => memRow(f.text, [f.topic && f.topic !== 'other' ? f.topic.toUpperCase() : '', f.learnt ? 'LEARNT' : '', String(f.added || '').slice(0, 10)].filter(Boolean).join(' · '),
      () => post({ type: 'action', name: 'memory-forget', id: f.id }), 'Forget this')) : [emptyRow('NOTHING REMEMBERED YET')]));
    $('n-memory').textContent = facts.length;
    $('mem-count').textContent = facts.length ? facts.length + ' FACT' + (facts.length === 1 ? '' : 'S') : '';
  }
  const REPEAT = { daily: 'EVERY DAY', weekdays: 'WEEKDAYS', weekly: 'EVERY WEEK', hourly: 'EVERY HOUR' };
  function setSchedule(items) {
    items = (Array.isArray(items) ? items : []).slice().sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase(); };
    $('sched-list').replaceChildren(...(items.length ? items.map((i) => memRow((i.kind === 'task' ? '⟳ ' : '⏰ ') + i.text, (i.repeat ? REPEAT[i.repeat] + ' · ' : '') + when(i.due),
      () => post({ type: 'action', name: 'schedule-cancel', id: i.id }), 'Cancel')) : [emptyRow('NOTHING SCHEDULED')]));
    $('sched-count').textContent = items.length ? String(items.length) : '';
  }
  // The rolling conversation summary: what JARVIS carries from older turns into a fresh session.
  const kTok = (n) => (n >= 1000 ? Math.round(n / 1000) + 'K' : String(n || 0));
  function setContext(c) {
    c = c || {};
    const pct = c.limit ? Math.min(100, Math.round((c.tokens || 0) / c.limit * 100)) : 0;
    $('ctx-bar').style.width = pct + '%';
    $('ctx-bar').classList.toggle('full', pct >= 90);
    $('ctx-state').textContent = c.rolling ? 'SUMMARISING…' : '';
    const when = c.rolledAt ? new Date(c.rolledAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase() : '';
    $('ctx-meta').textContent = [`CONTEXT ${kTok(c.tokens)} / ${kTok(c.limit)} TOKENS`, `${c.lines || 0} TURN${c.lines === 1 ? '' : 'S'} SINCE THE SUMMARY`, when ? `SUMMARISED ${when}` : ''].filter(Boolean).join(' · ');
    const box = $('ctx-summary');
    box.classList.toggle('empty', !c.summary);
    box.textContent = c.summary || 'NO SUMMARY YET. OLDER TURNS ARE SUMMARISED WHEN THE CONVERSATION GETS LONG OR A NEW DAY STARTS. THE LATEST DOZEN ALWAYS STAY WORD FOR WORD.';
    $('ctx-roll').disabled = !!c.rolling;
  }
  $('ctx-roll').addEventListener('click', () => post({ type: 'action', name: 'context-roll' }));
  $('ctx-clear').addEventListener('click', () => { if (confirm('Forget this conversation and its summary?')) post({ type: 'action', name: 'new' }); });
  $('mem-add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = $('mem-input').value.trim();
    if (v) post({ type: 'action', name: 'memory-add', text: v });
    $('mem-input').value = '';
  });

  // ---------- history (chat) ----------
  const history = [];
  let nativeHistory = false, lastFinalTranscript = '', lastReply = '';
  function renderHistory() {
    const ul = $('chat'); ul.textContent = '';
    if (!history.length) { const e = document.createElement('li'); e.className = 'empty'; e.textContent = 'NO EXCHANGES YET'; ul.appendChild(e); return; }
    history.forEach((h) => {
      const li = document.createElement('li');
      const t = document.createElement('span'); t.className = 't'; t.textContent = h.t || '';
      const b = document.createElement('div');
      const you = document.createElement('div'); you.className = 'you'; you.textContent = h.you || '';
      const jv = document.createElement('div'); jv.className = 'jv'; jv.textContent = h.jarvis || '…';
      b.appendChild(you); b.appendChild(jv); li.appendChild(t); li.appendChild(b); ul.appendChild(li);
    });
    if (body.dataset.view === 'history') ul.scrollTop = ul.scrollHeight;
    $('n-turns').textContent = history.length;
    const turns = stats.turns || history.length;
  }
  renderHistory();
  function localHistoryTurn() {
    if (nativeHistory || !lastFinalTranscript) return;
    const d = new Date(), t = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const prev = history[history.length - 1];
    if (prev && prev.you === lastFinalTranscript) { prev.jarvis = lastReply; } else { history.push({ t, you: lastFinalTranscript, jarvis: lastReply }); stats.turns++; }
    while (history.length > 200) history.shift();
    renderHistory();
  }

  // ---------- system / services readouts ----------
  function kv(id, text, pct) {
    const b = $(id); b.textContent = text;
    const p = +pct || 0; b.classList.toggle('hot', p >= 75 && p < 92); b.classList.toggle('crit', p >= 92);
  }
  function setSystem(s) {
    kv('k-cpu', Math.round(s.cpu || 0) + '%', s.cpu);
    kv('k-ram', Math.round(s.ram || 0) + '%' + (s.ramUsedGB != null ? ' (' + s.ramUsedGB + '/' + s.ramTotalGB + ' GB)' : ''), s.ram);
    kv('k-disk', Math.round(s.disk || 0) + '%' + (s.diskFreeGB != null ? ' (' + s.diskFreeGB + ' GB FREE)' : ''), s.disk);
    kv('k-bat', s.battery == null ? '—' : s.battery + '%' + (s.charging ? '⚡' : ''), 0);
    kv('k-up', s.uptime || '—', 0); kv('k-host', (s.host || '—').toUpperCase(), 0);
    host = s.host || host;
    setKV('host', s.host || '—');
  }
  function svc(id, on, warn) { const el = $(id); el.className = warn ? 'warn' : on ? 'on' : ''; el.querySelector('b').textContent = on || warn ? '●' : '○'; }
  function setKV(k, v) { document.querySelectorAll('[data-kv="' + k + '"]').forEach((e) => { e.textContent = v; }); }
  function setStats(st) {
    Object.assign(stats, st || {});
    const ag = Array.isArray(stats.agents) ? stats.agents : [];
    crew.classList.toggle('busy', ag.length > 0);
    $('br-worker').textContent = ag.length ? `${ag.length} JOB${ag.length === 1 ? '' : 'S'} · ${String(ag[0]).toUpperCase().slice(0, 28)}` : 'NO JOBS RUNNING';
    renderServices();
  }
  function renderServices() {
    const ver = (info.claude || '').replace(/\s*\(Claude Code\)/i, '');
    const model = stats.brainModel || info.model || '—';
    svc('s-claude', stats.brainReady, !stats.brainReady && !!ver);
    $('s-model').querySelector('span').textContent = 'MODEL · ' + model.toUpperCase();
    svc('s-model', !!model && model !== '—');
    const tts = (stats.tts || info.voice || '');
    $('s-tts').querySelector('span').textContent = /kokoro/i.test(tts) ? 'KOKORO' : /edge|Neural/i.test(tts) ? 'EDGE TTS' : 'VOICE';
    svc('s-tts', !!tts);
    svc('s-stt', true);
    const tg = stats.telegram || 'off';
    svc('s-tg', tg !== 'off');
    $('r-model').textContent = model.toUpperCase() + (stats.effort ? ' · ' + stats.effort.toUpperCase() : '');
    $('bl-ver').textContent = 'CLAUDE CODE ' + (ver || '—');
    $('bl-voice').textContent = 'VOICE ' + (tts ? tts.toUpperCase() : '—');
    $('br-tg').textContent = 'TELEGRAM ' + (tg !== 'off' ? tg.toUpperCase() : 'OFF');
    setKV('model', model); setKV('effort', stats.effort || '—'); setKV('tts', tts || '—'); setKV('stt', stats.stt || 'Apple on-device');
    setKV('telegram', tg !== 'off' ? tg : 'not configured'); setKV('claude', ver || '—');
  }
  setStats({});

  // ---------- panels / notice ----------
  function sanitize(html) {
    const tpl = document.createElement('template'); tpl.innerHTML = String(html || '');
    const out = document.createDocumentFragment();
    (function walk(src, dst) {
      src.childNodes.forEach((n) => {
        if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.textContent)); return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (tag === 'b' || tag === 'strong' || tag === 'i' || tag === 'em') { const el = document.createElement(tag === 'strong' ? 'b' : tag === 'em' ? 'i' : tag); walk(n, el); dst.appendChild(el); }
        else if (tag === 'br') dst.appendChild(document.createElement('br'));
        else if (tag === 'script' || tag === 'style') { /* drop */ }
        else { if (/^(p|div|li|h\d|tr)$/.test(tag) && dst.childNodes.length) dst.appendChild(document.createElement('br')); walk(n, dst); }
      });
    })(tpl.content, out);
    return out;
  }
  function addPanel(title, html) {
    const wrap = $('panels');
    const p = document.createElement('div'); p.className = 'panel';
    const h = document.createElement('h3'); h.textContent = title || 'PANEL';
    const b = document.createElement('div'); b.appendChild(sanitize(html));
    p.appendChild(h); p.appendChild(b); wrap.appendChild(p);
    while (wrap.children.length > 2) wrap.removeChild(wrap.firstChild);
    setTimeout(() => { p.classList.add('out'); setTimeout(() => p.remove(), 700); }, 20000);
  }
  let noticeTimer;
  function notice(text) {
    const n = $('notice'); n.textContent = text; n.classList.add('show');
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => n.classList.remove('show'), 4000);
  }

  // ---------- boot ----------
  const BOOT_LINES = ['INITIALISING', 'AUDIO ENGINE', 'BRAIN', 'SESSION RADAR'];
  let bootTyped = false, bootSignalled = false;
  (function typeLines() {
    const box = $('bootlines');
    BOOT_LINES.forEach((t, i) => {
      setTimeout(() => {
        const d = document.createElement('div'); d.textContent = t; box.appendChild(d);
        setTimeout(() => d.classList.add('ok'), 300);
        if (i === BOOT_LINES.length - 1) setTimeout(() => { bootTyped = true; maybeFinishBoot(); }, 500);
      }, 250 + i * 420);
    });
    setTimeout(() => { bootSignalled = true; bootTyped = true; maybeFinishBoot(); }, 9000);
  })();
  function bootSignal() { bootSignalled = true; maybeFinishBoot(); }
  function maybeFinishBoot() {
    if (boot.done || !bootTyped || !bootSignalled) return;
    boot.done = true;
    const d = document.createElement('div'); d.textContent = 'ONLINE'; d.classList.add('ok'); $('bootlines').appendChild(d);
    setTimeout(() => { $('boot').classList.add('done'); body.classList.remove('booting'); if (state === 'booting') setState('idle'); }, 400);
    setTimeout(() => { $('boot').style.display = 'none'; }, 1300);
  }

  // ---------- events from native ----------
  // ---------- other devices: their tabs and their HUD ----------
  // Events that make up a device's HUD. This device's are kept while another device's tab is open, and
  // shown again when it closes; another device's arrive as 'remote' and are kept per device.
  const MIRRORED = ['info', 'stats', 'system', 'state', 'ext', 'assistants', 'assistant', 'sessions', 'conversation', 'assistant-error', 'assistant-try'];
  const machineName = (id) => (devList.find((d) => d.id === id) || {}).name || 'Other device';
  /** Paired devices whose HUD we have, with their agents, for the Devices node. */
  function remoteDevices() {
    return devList.map((d) => {
      const a = (views[d.id] || {}).assistants || {};
      return { id: d.id, name: d.name, os: d.os, via: d.via, list: Array.isArray(a.list) ? a.list : [], current: a.id || '' };
    }).filter((d) => d.list.length);
  }
  function renderMachines() {
    const bar = $('machines');
    bar.hidden = !devList.length;
    const tab = (id, name, sub, cls) => {
      const b = document.createElement('button');
      b.className = 'mtab' + (id === machine ? ' on' : '') + (cls ? ' ' + cls : '');
      b.dataset.device = id;
      b.innerHTML = '<i></i>';
      b.append(document.createTextNode(name));
      b.title = sub;
      b.addEventListener('click', () => showMachine(id));
      return b;
    };
    bar.replaceChildren(tab('', devName ? `${devName} (this)` : 'This device', 'This device'),
      ...devList.map((d) => tab(d.id, d.name, `${d.os || ''} · ${{ 'local network': 'on your Wi-Fi', direct: 'connected directly', relay: 'through the relay', offline: 'not reachable' }[d.via] || d.via}`, d.via === 'relay' ? 'relay' : d.via === 'offline' ? 'off' : 'live')));
  }
  /** Show a device's HUD: this one ('') or a paired one. */
  function showMachine(id) {
    if (id && !devList.some((d) => d.id === id)) id = '';
    if (spotted) unspot();
    machine = id;
    crewGroup = 'main';
    postLocal({ type: 'action', name: 'dev:focus', device: id });
    body.classList.toggle('remote', !!id);
    if (id && ['history', 'memory', 'settings', 'music'].includes(body.dataset.view)) showView('cc');
    const v = views[id] || {};
    for (const t of MIRRORED) if (v[t] && !/^assistant-(error|try)$/.test(t)) dispatch(v[t]);
    if (id) {
      const d = devList.find((x) => x.id === id);
      // Over the relay there is no live stream: load the view once, and again with the tab.
      if (!d || d.via !== 'local network' && d.via !== 'direct') postLocal({ type: 'action', name: 'dev:view', device: id });
      $('remote-note').textContent = !v.assistants ? `Loading ${machineName(id)}…` : d && (d.via === 'local network' || d.via === 'direct') ? '' : `${machineName(id)} isn't connected directly, so this is its latest state. Open the tab again to refresh.`;
    } else $('remote-note').textContent = '';
    renderMachines();
  }
  function onRemote(e) {
    const v = views[e.device] || (views[e.device] = {});
    const evs = e.snap ? Object.values(e.snap) : e.e ? [e.e] : [];
    for (const x of evs) if (x && x.type && MIRRORED.includes(x.type)) { v[x.type] = x; if (machine === e.device) dispatch(x); }
    if (machine === e.device) $('remote-note').textContent = '';
    // Its agents feed the Devices node on this device's HUD.
    if (!machine && evs.some((x) => x && x.type === 'assistants') && crewGroup !== 'main') { HUBS = hubsFor(); crew.innerHTML = buildCrew(); }
    else if (!machine && evs.some((x) => x && x.type === 'assistants') && !HUBS.some((h) => h.group === 'devices') && remoteDevices().length) { HUBS = hubsFor(); crew.innerHTML = buildCrew(); }
  }

  window.hud = {
    event(e) {
      if (!e || !e.type) return;
      if (e.type === 'remote') { onRemote(e); return; }
      if (e.type === 'devices') {
        devList = e.list || []; devName = e.name || '';
        if (machine && !devList.some((d) => d.id === machine)) showMachine('');
        renderMachines();
        if (!machine && !spotted) { HUBS = hubsFor(); crew.innerHTML = buildCrew(); }
        pairNews(e);
      }
      if (MIRRORED.includes(e.type)) { views[''][e.type] = e; if (machine) return; }
      dispatch(e);
    },
  };
  function dispatch(e) {
    {
      switch (e.type) {
        case 'state': setState(e.state); break;
        case 'mode': setMode(e); break;
        case 'music': setMusic(e); break;
        case 'music_stations': musicCredit = e.credit || ''; setStations(e.stations || []); break;
        case 'youtube_presets': ytPresets = e.presets || []; renderStations(); break;
        case 'transcript': {
          const t = $('transcript'), changed = t.textContent !== (e.text || '');
          t.textContent = e.text || ''; t.classList.toggle('final', !!e.final);
          if (e.text && !e.final && $('reply').textContent) { $('reply').textContent = ''; $('reply').className = ''; }
          if (e.final && e.text) { lastFinalTranscript = e.text; lastReply = ''; }
          if (changed && e.text) armCaptions();
          break;
        }
        case 'reply': {
          const r = $('reply'), changed = r.textContent !== unmd(e.text);
          r.textContent = unmd(e.text); r.className = e.error ? 'error' : (e.text ? 'live' : '');
          if (e.text) { lastReply = e.text; localHistoryTurn(); }
          if (changed && e.text) armCaptions();
          break;
        }
        case 'tool': addTool(e.name, e.summary); break;
        case 'mic': micLevel = Math.max(micLevel, Math.min(1, +e.level || 0)); break;
        case 'voice': voiceLevel = Math.max(voiceLevel * 0.5, Math.min(1, +e.level || 0)); break;
        case 'sessions': setSessions(e.data); break;
        case 'memory': setMemory(e.data); break;
        case 'assistants': setAssistants(e); break;
        case 'assistant': setAssistants({ id: e.id }); break;
        case 'assistant-error': aNote(e.text, true); if (making) { making = false; pairHint(String(e.text).toUpperCase(), true); } break;
        case 'assistant-try': tried(e); break;
        case 'ext': setExt(e); break;
        case 'context': setContext(e.data); break;
        case 'schedule': setSchedule(e.data); break;
        case 'info': Object.assign(info, e); setStats({}); break;
        case 'theme': jarvisTheme.apply(e.theme, e.mode); break;
        case 'settings': setSettings(e); if (window.jarvisSettings) window.jarvisSettings.event(e); break;
        case 'open-settings': if (e.section === 'assistant') { showView('agents'); break; } showView('settings'); if (window.jarvisSettings) window.jarvisSettings.open(e.section || ''); break;
        case 'devices': if (window.jarvisSettings) window.jarvisSettings.event(e); break;
        default: if (/^cfg-/.test(e.type) && window.jarvisSettings) window.jarvisSettings.event(e);
        case 'boot': bootSignal(); break;
        case 'panel': addPanel(e.title, e.html); break;
        case 'notice': notice(e.text || ''); break;
        case 'system': setSystem(e); break;
        case 'stats': setStats(e); break;
        case 'conversation': setConversation(e); break;
        case 'history': {
          nativeHistory = true; history.length = 0;
          (Array.isArray(e.data) ? e.data : []).forEach((h) => history.push(h));
          renderHistory(); break;
        }
      }
    }
  }

  // ---------- background music (Home block + MUSIC tab) ----------
  let musicOn = false, musicId = '', musicSrc = 'radio', stations = [], musicCredit = '', ytPresets = [];
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setMusic(m) {
    musicOn = !!m.playing; musicId = m.id || musicId; musicSrc = m.source || 'radio';
    const name = m.name || 'Lofi Beats', title = (m.title && m.title !== name) ? m.title : '';
    $('n-music').textContent = musicOn ? ('· ' + (title || name)).slice(0, 34) : '';
    document.body.classList.toggle('music-on', musicOn);
    $('mh-src').textContent = musicOn ? ('NOW PLAYING · ' + (musicSrc === 'youtube' ? 'YOUTUBE' : 'RADIO')) : 'NOTHING PLAYING';
    $('mh-name').textContent = musicOn ? name : 'Choose something to play';
    const mt = $('mh-title'); const newTitle = musicOn ? (title || (m.note || '')) : 'Pick a station or a YouTube stream below';
    if (mt.textContent !== newTitle) { mt.classList.remove('swap'); void mt.offsetWidth; mt.classList.add('swap'); mt.textContent = newTitle; }
    $('mh-play').textContent = musicOn ? '■' : '▶';
    if (typeof m.volume === 'number') {
      if (document.activeElement !== $('mh-vol')) { $('mh-vol').value = m.volume; $('mh-volv').textContent = m.volume + '%'; }
    }
    renderStations();
  }
  function setStations(list) { stations = list; renderStations(); }
  function renderStations() {
    const groups = [['favourite', 'FAVOURITES'], ['instrumental', 'INSTRUMENTAL'], ['popular', 'INDIA · POPULAR']];
    $('mus-radio').innerHTML = groups.map(([g, title]) => {
      const list = stations.filter((st) => (st.group || 'instrumental') === g);
      if (!list.length) return '';
      return `<div class="sub">${title}</div>` + list.map((st) => {
        const on = musicOn && musicSrc === 'radio' && st.id === musicId;
        return `<button data-id="${esc(st.id)}" class="${on ? 'on' : ''}"><span class="eq sm"><i></i><i></i><i></i></span><b>${esc(st.name)}</b><i>${esc(st.note)}</i></button>`;
      }).join('');
    }).join('');
    $('mus-yt').innerHTML = ytPresets.map((p) => `<button data-yt="${esc(p.id)}" class="${musicOn && musicSrc === 'youtube' && $('mh-name').textContent.includes(p.name) ? 'on' : ''}"><span class="eq sm"><i></i><i></i><i></i></span><b>${esc(p.name)}</b><i>${esc(p.note)}</i></button>`).join('');
    $('mus-credit').textContent = musicCredit;
  }
  const volInput = (ev) => { const v = Number(ev.target.value); $('mh-volv').textContent = v + '%'; post({ type: 'action', name: 'music-volume', value: v }); };
  $('mh-vol').addEventListener('input', volInput);
  $('mh-play').addEventListener('click', () => post({ type: 'action', name: 'music' }));
  $('mh-next').addEventListener('click', () => post({ type: 'action', name: 'music-next' }));
  $('mus-radio').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) post({ type: 'action', name: 'music-select', id: b.dataset.id }); });
  $('mus-yt').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) post({ type: 'action', name: 'youtube-play', id: b.dataset.yt }); });
  $('yt-window').addEventListener('click', () => post({ type: 'action', name: 'youtube-window' }));
  $('yt-stop').addEventListener('click', () => post({ type: 'action', name: 'youtube-stop' }));
  // Editable settings: each change is saved and applied by main at once.
  let savedTimer = null, lastHands = null;
  function showTts() {
    const eng = document.querySelector('[data-key="ttsEngine"]').value;
    document.querySelectorAll('[data-tts]').forEach((li) => { li.hidden = li.dataset.tts !== eng; });
  }
  function setHands(h, on) {
    const st = $('hands-state'), btn = $('hands-permit');
    $('hands-row').hidden = !on;
    if (!h) { st.textContent = 'checking…'; btn.hidden = true; return; }
    if (h.missing) { st.textContent = 'helper not built (./setup.sh)'; btn.hidden = true; return; }
    const need = [!h.ax && 'Accessibility', !h.screen && 'Screen Recording'].filter(Boolean);
    st.textContent = need.length ? 'needs ' + need.join(' + ') : 'allowed';
    btn.hidden = !need.length;
  }
  function setSettings(e) {
    // The macOS voices, for each agent's voice on the Agents tab.
    if (Array.isArray(e.sayVoices) && e.sayVoices.length) {
      const ns = $('ag-native'), keep = ns.value;
      ns.replaceChildren(...e.sayVoices.map((v) => new Option(v, v)));
      if (keep) { if (![...ns.options].some((o) => o.value === keep)) ns.append(new Option(keep, keep)); ns.value = keep; }
    }
    if (e.values && e.values.ttsEngine && e.values.ttsEngine !== env.engine) { env.engine = e.values.ttsEngine; if (assistants.length) renderAssistantCards(); }
    const av = e.available;
    if (av) {
      const opt = (key, val) => document.querySelector(`[data-key="${key}"] option[value="${val}"]`);
      opt('ttsEngine', 'kokoro').disabled = !av.kokoro;
      opt('ttsEngine', 'edge').disabled = !av.edge;
      opt('ttsEngine', 'elevenlabs').disabled = !av.elevenlabs;
      opt('sttEngine', 'elevenlabs').disabled = !av.elevenlabs;
    }
    for (const [k, v] of Object.entries(e.values || {})) {
      const el = document.querySelector(`[data-key="${k}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else {
        // A saved macOS voice "Daniel" matches the listed "Daniel (English (UK))".
        if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(v))) {
          const near = [...el.options].find((o) => o.value.startsWith(String(v)) || String(v).startsWith(o.value));
          el.value = near ? near.value : el.options[0]?.value;
        } else el.value = v;
      }
    }
    if ('hands' in e || (e.values && 'screenControl' in e.values)) {
      if ('hands' in e) lastHands = e.hands;
      setHands(lastHands, document.querySelector('[data-key="screenControl"]').checked);
    }
    if (e.values && 'autoHide' in e.values) { focus.on = !!e.values.autoHide; armFocus(); }
    if (e.autoHideMs) { focus.ms = e.autoHideMs; armFocus(); }
    renderSetCards(e);
    showTts();
  }
  // The summary under each section in the Settings sidebar.
  const setVals = {};
  function renderSetCards(e) {
    Object.assign(setVals, e.values || {});
    if ('brain' in e) setVals.brain = e.brain;
    if ('workerAvailable' in e) setVals.workerAvailable = e.workerAvailable;
    if (e.hands) setVals.hands = e.hands;
    const v = setVals;
    $('sc-brain').textContent = 'Claude Code, API keys, Ollama';
    const h = v.hands || {};
    $('sc-access').textContent = h.missing ? 'Mic · speech' : `Mic · speech · apps ${h.ax ? '✓' : '✗'} · screen ${h.screen ? '✓' : '✗'}`;
    $('sc-ears').textContent = v.sttEngine === 'elevenlabs' ? 'ElevenLabs Scribe' : `On-device · ${v.speechLocale || ''}`;
    $('sc-voice').textContent = { kokoro: 'Kokoro', elevenlabs: 'ElevenLabs', edge: 'Edge neural', native: 'macOS voice' }[v.ttsEngine] || v.ttsEngine || '—';
    $('sc-extras').textContent = `Telegram ${stats.telegram && stats.telegram !== 'off' ? stats.telegram : 'off'}`;
  }

  document.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', () => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.dataset.key === 'ttsEngine') showTts();
    post({ type: 'action', name: 'settings', patch: { [el.dataset.key]: v } });
    $('set-saved').classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('set-saved').classList.remove('on'), 1500);
  }));
  $('test-voice').addEventListener('click', () => post({ type: 'action', name: 'test-voice' }));
  $('hands-permit').addEventListener('click', () => post({ type: 'action', name: 'hands-permit' }));

  // Appearance: applies at once here, main saves it and updates the other windows.
  function markLook() {
    const w = jarvisTheme.wanted();
    document.querySelectorAll('[data-theme-pick]').forEach((b) => b.classList.toggle('on', b.dataset.themePick === w.theme));
    document.querySelectorAll('[data-mode-pick]').forEach((b) => b.classList.toggle('on', b.dataset.modePick === w.mode));
    const names = { jarvis: 'JARVIS', terminal: 'Terminal', neon: 'Neon', stark: 'Stark', minimal: 'Minimal' };
    $('sc-look').textContent = `${names[w.theme] || w.theme} · ${w.mode === 'system' ? 'matches macOS' : w.mode}`;
  }
  document.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
    jarvisTheme.apply(b.dataset.themePick); markLook(); post({ type: 'action', name: 'theme', theme: b.dataset.themePick });
  }));
  document.querySelectorAll('[data-mode-pick]').forEach((b) => b.addEventListener('click', () => {
    jarvisTheme.apply(undefined, b.dataset.modePick); markLook(); post({ type: 'action', name: 'theme', mode: b.dataset.modePick });
  }));
  jarvisTheme.onChange(markLook);
  markLook();
  // animated visualiser bars in the MUSIC hero
  (function buildViz() { const v = $('mh-viz'); v.innerHTML = Array.from({ length: 48 }, (_, i) => `<i style="animation-delay:${(i * 73 % 900) / 1000}s;animation-duration:${0.7 + (i * 37 % 60) / 100}s"></i>`).join(''); })();

  // ---------- the only control: ACTIVATE/DEACTIVATE (plus Esc = stop, keyboard only) ----------
  document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => post({ type: 'action', name: b.dataset.action })));
  // ---------- full mode: HOME slides its panels away after a few idle seconds ----------
  // Only the reactor and the crew stay, wherever the pointer is. Any mouse or key activity brings
  // everything back. An open menu or a field being typed in keeps the panels up.
  const focus = { on: true, ms: 4000, timer: 0, allowed: !DEMO || /[?&]focus=1/.test(location.search) };
  function armFocus() {
    clearTimeout(focus.timer);
    body.classList.remove('focus');
    if (!focus.on || !focus.allowed) return;
    focus.timer = setTimeout(function tryFocus() {
      const busy = body.dataset.view !== 'cc' || !livePop.hidden || !!spotted || document.activeElement?.matches('input, select, textarea');
      if (busy) { focus.timer = setTimeout(tryFocus, focus.ms); return; }
      // Where the panels are, before they slide away: moving onto one brings them back.
      focus.zones = ['lc', 'tr', 'brand', 'ask', 'bl', 'br'].map((id) => $(id) && $(id).getBoundingClientRect()).filter((r) => r && r.width);
      body.classList.add('focus');
    }, focus.ms);
  }
  // While focused, the pointer can move over the crew to click one. Moving onto where a panel lives
  // (unless it's on a crew member), a click elsewhere, a key or the wheel brings the panels back.
  const nearCrew = (x, y) => HUBS.some((h) => { const r = $('crew-' + h.id).querySelector('.hit').getBoundingClientRect(); return Math.hypot(x - (r.x + r.width / 2), y - (r.y + r.height / 2)) < Math.max(60, r.width / 2 + 24) || $('crew-' + h.id).querySelector('.nm').getBoundingClientRect().right + 8 > x && x > $('crew-' + h.id).querySelector('.nm').getBoundingClientRect().left - 8 && Math.abs(y - (r.y + r.height / 2)) < 40; });
  document.addEventListener('mousemove', (ev) => {
    if (!body.classList.contains('focus')) { armFocus(); return; }
    body.classList.add('pointer');
    clearTimeout(focus.hintTimer);
    focus.hintTimer = setTimeout(() => body.classList.remove('pointer'), 2500);
    const x = ev.clientX, y = ev.clientY;
    if ((focus.zones || []).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) && !nearCrew(x, y)) armFocus();
  }, { passive: true });
  document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('#crew .mate')) armFocus(); }, { passive: true });
  for (const type of ['wheel', 'keydown']) document.addEventListener(type, armFocus, { passive: true });
  armFocus();

  // ---------- the input bar: typed messages go to JARVIS like spoken ones ----------
  const askInput = $('ask-input');
  askInput.addEventListener('input', () => { $('ask-send').disabled = !askInput.value.trim(); });
  $('ask').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = askInput.value.trim();
    if (!text) return;
    post({ type: 'action', name: 'type', text });
    askInput.value = '';
    $('ask-send').disabled = true;
  });
  askInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    if (askInput.value) askInput.value = ''; else if (spotted) unspot(); else askInput.blur();
    $('ask-send').disabled = true;
  });
  // Cmd+K, or "/" when not already typing somewhere, puts the cursor in the bar.
  document.addEventListener('keydown', (ev) => {
    const typing = document.activeElement && document.activeElement.matches('input, select, textarea');
    if ((ev.metaKey && ev.key.toLowerCase() === 'k') || (ev.key === '/' && !typing)) {
      ev.preventDefault();
      if (body.dataset.view !== 'cc') showView('cc');
      askInput.focus();
    }
  });

  document.addEventListener('keydown', (ev) => { if (ev.key !== 'Escape') return; if (!livePop.hidden) { livePop.hidden = true; return; } if (spotted) { unspot(); return; } post({ type: 'action', name: 'stop' }); });

  // ---------- theme: reactor colours follow the CSS theme ----------
  function applyThemeToScene(t) {
    const css = getComputedStyle(document.documentElement);
    const v = (k, d) => (css.getPropertyValue(k) || '').trim() || d;
    COL.cyan.set(v('--cyan', '#39c3ff')); COL.dim.set(v('--dim', '#1b4d73')); COL.amber.set(v('--amber', '#ffb347'));
    COL.green.set(v('--green', '#7dffb3')); COL.red.set(v('--red', '#ff4d4d')); COL.grey.set(v('--grey', '#6b7a8a'));
    COL.white.set(v('--core', '#ffffff'));
    // Additive glow vanishes on a light background; draw normally there.
    const blending = t.mode === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
    scene.traverse((o) => { if (o.material && o.material.blending !== blending) { o.material.blending = blending; o.material.needsUpdate = true; } });
    coreMat.color.copy(COL.white);
    // Soft glow sprites read as grey smudges on light backgrounds.
    halo.visible = halo2.visible = glow.visible = t.mode !== "light";
  }
  jarvisTheme.onChange(applyThemeToScene);
  applyThemeToScene(jarvisTheme.current());

  requestAnimationFrame(frame);
  post({ type: 'ready' });

  // ---------- demo mode (?demo=1 / Safari) ----------
  if (DEMO) {
    const ev = (o) => window.hud.event(o);
    ev({ type: 'music_stations', credit: 'Office Lounge music by Kevin MacLeod (incompetech.com), CC BY 4.0.', stations: [
      { id: 'rb1', name: 'Radio Mirchi Hindi', note: 'IN · radio', group: 'favourite' },
      { id: 'lofi', name: 'Lofi Beats', note: 'chill lo-fi instrumentals · radio', group: 'instrumental' },
      { id: 'ambient', name: 'Ambient Sleeping Pill', note: 'soft ambient, no beats · radio', group: 'instrumental' },
      { id: 'swissjazz', name: 'Radio Swiss Jazz', note: 'calm jazz, few vocals · radio', group: 'instrumental' },
      { id: 'rb2', name: 'Vividh Bharati', note: 'IN · radio', group: 'popular' }, { id: 'rb3', name: 'Mirchi Love', note: 'IN · radio', group: 'popular' },
      ...Array.from({ length: 16 }, (_, i) => ({ id: 'p' + i, name: 'Popular station ' + (i + 1), note: 'IN · radio', group: 'popular' })) ] });
    ev({ type: 'youtube_presets', presets: [ { id: 'lofigirl', name: 'Lofi Girl', note: '24/7 lofi hip-hop live' }, { id: 'cafebgm', name: 'Cafe Music BGM', note: 'jazz & bossa café live' } ] });
    ev({ type: 'music', playing: true, source: 'radio', id: 'lofi', name: 'Lofi Beats', note: 'chill lo-fi instrumentals · radio', title: 'Kupla - Valentine', volume: 24 });
    ev({ type: 'info', claude: '2.1.309 (Claude Code)', model: 'opus', voice: 'kokoro bm_george' });
    ev({ type: 'stats', turns: 22, toolCalls: 14, memories: 38, sessionsActive: 2, brainModel: 'opus', effort: 'low', brainReady: true, tts: 'kokoro bm_george', stt: 'apple on-device', telegram: '@my_jarvis_bot', agents: ['checking your Gmail'] });
    ev({ type: 'system', cpu: 36, ram: 72, ramUsedGB: 12.5, ramTotalGB: 17.2, disk: 89, diskFreeGB: 24, battery: 70, charging: true, uptime: '4d 20h', host: 'macbook' });
    ev({ type: 'history', data: [
      { t: '09:30', you: 'what are my sessions doing', jarvis: 'Two are busy, sir. The web app is running its tests and the API server is mid-build. The blog and the docs are idle.' },
      { t: '10:12', you: 'open netflix in chrome', jarvis: 'Netflix is open in Chrome.' },
      { t: '11:02', you: 'check my gmail for today', jarvis: 'Opening your inbox now. I\'ll tell you what needs a reply.' },
      { t: '11:06', you: '(agent)', jarvis: 'Three new emails. Only the one from your landlord needs a reply today.' },
      { t: '11:18', you: 'remind me at five to call the bank', jarvis: 'Done. I\'ll remind you at five.' },
    ] });
    ev({ type: 'context', data: { tokens: 41200, limit: 70000, lines: 9, rolledAt: new Date(Date.now() - 3 * 3600e3).toISOString(), summary: 'Waiting on the user\n- Their go to send the reply to the landlord that JARVIS drafted.\n\nWhat the background jobs found\n- The payments test fails because of a missing comma in config.json (11:40).\n\nFacts the user stated\n- Flying to Delhi on Friday morning.' } });
    ev({ type: 'memory', data: [
      { id: 'm1', text: 'Prefers lo-fi music while working.', topic: 'preference', added: '2026-10-21T09:12' },
      { id: 'm2', text: 'Lives in Bengaluru and works from home on Fridays.', topic: 'place', added: '2026-10-22T18:40' },
      { id: 'm3', text: 'Sister is called Priya; her birthday is on 14 November.', topic: 'person', added: '2026-10-23T20:05' },
      { id: 'm4', text: '"The web app" means the project in ~/Projects/web-app.', topic: 'project', added: '2026-10-24T11:30' },
      { id: 'm5', text: 'Goes for a run most mornings around seven.', topic: 'routine', added: '2026-10-24T07:55' },
      { id: 'm6', text: 'Wants LinkedIn posts casual and short, with no hashtags.', topic: 'preference', added: '2026-10-25T16:20', learnt: true },
    ] });
    const at = (h, m, d = 0) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(h)}:${p(m)}`; };
    ev({ type: 'schedule', data: [
      { id: 'r1', kind: 'reminder', text: 'Call the bank about the card.', due: at(17, 0), repeat: null },
      { id: 'r2', kind: 'task', text: 'Check the AI news and tell me only what is new.', due: at(8, 0, 1), repeat: 'daily' },
      { id: 'r3', kind: 'task', text: 'Summarise my inbox and tell me what needs a reply.', due: at(9, 0, 1), repeat: 'weekdays' },
      { id: 'r4', kind: 'reminder', text: 'Order a birthday gift for Priya.', due: at(10, 0, 5), repeat: null },
    ] });
    ev({ type: 'settings', brain: 'claude code · sonnet', hands: { ax: true, screen: true }, available: { kokoro: true, edge: true, elevenlabs: false },
      values: { ttsEngine: 'kokoro', kokoroVoice: 'bm_george', kokoroSpeed: 1.05, sttEngine: 'apple', appleSpeech: 'instant', speechLocale: 'en-GB', commandSilenceSeconds: 2, requireEndWord: false,
        model: 'sonnet', effort: 'low', agentModel: 'opus', progressUpdates: 'normal', morningBriefing: true, checkIns: 'sometimes', screenControl: true, honorific: 'sir', announceSessions: true, autoHide: true } });
    const fake = [
      { name: 'JARVIS brain', kind: 'jarvis', cwd: '~', status: 'working', ago: '2s ago', last: 'using Bash', modified: 11 },
      { name: 'web-app', kind: 'claude', cwd: '~/Projects/web-app', status: 'working', ago: '12s ago', last: 'Running the test suite for the meeting importer; two suites remaining.', modified: 9, terminal: { tty: 'ttys010' } },
      { name: 'blog', kind: 'claude', cwd: '~/Projects/blog', status: 'idle', ago: '5m ago', last: 'Okay, we will leave the photos out of this post. Nothing was changed.', modified: 8, terminal: { tty: 'ttys009' } },
      { name: 'api-server', kind: 'claude', cwd: '~/Projects/api-server', status: 'working', ago: '41s ago', last: 'using Bash', modified: 7 },
      { name: 'docs', kind: 'claude', cwd: '~/Projects/docs', status: 'idle', ago: '17m ago', last: 'The release notes are ready for review.', modified: 6 },
      { name: 'mobile-app', kind: 'claude', cwd: '~/Projects/mobile-app', status: 'done', ago: '2h ago', last: 'Build complete.', modified: 4 },
    ];
    setTimeout(() => { ev({ type: 'boot', ok: true }); ev({ type: 'sessions', data: fake }); }, 900);
    const tailEntries = [
      { t: '19:56', who: 'you', name: 'YOU', text: 'Check my Gmail and tell me what needs a reply.' },
      { t: '19:56', who: 'jarvis', name: 'JARVIS', text: "Going through your inbox now, sir." },
      { t: '19:58', who: 'jarvis', name: 'JARVIS', text: 'Three new emails. Only the one from your bank needs a reply.' },
      { t: '20:01', who: 'you', name: 'YOU', text: 'Draft a polite reply saying I will call them tomorrow.' },
      { t: '20:01', who: 'jarvis', name: 'JARVIS', text: 'Drafting it now. I will read it to you before anything is sent.' },
    ];
    let tailN = 2;
    setInterval(() => { tailN = Math.min(tailEntries.length, tailN + 1); ev({ type: 'conversation', key: 'jarvis', name: 'JARVIS', status: tailN < tailEntries.length ? 'working' : 'idle', ago: '', jobs: 1, entries: tailEntries.slice(0, tailN) }); }, 1500);
    const tools = [['Bash', 'sessions.sh'], ['Read', '~/.claude/projects/…/transcript.jsonl'], ['WebSearch', 'kokoro onnx british voices'], ['Bash', 'send.sh web-app "run the tests"'], ['Bash', 'mac.sh screenshot'], ['Agent', 'agent: checking your Gmail']];
    const cycle = ['idle', 'listening', 'thinking', 'speaking'];
    let i = 0;
    // &tour=1: a script drives the HUD (tools/make-demo.mjs), so no random cycling.
    if (!/[?&]tour=1/.test(location.search)) setInterval(() => {
      const s = cycle[i++ % cycle.length]; ev({ type: 'state', state: s });
      if (s === 'listening') ev({ type: 'transcript', text: 'jarvis, what are my sessions doing', final: false });
      if (s === 'thinking') { ev({ type: 'transcript', text: 'what are my sessions doing', final: true }); ev({ type: 'reply', text: '' }); const t = tools[(i >> 1) % tools.length]; ev({ type: 'tool', name: t[0], summary: t[1] }); }
      if (s === 'speaking') ev({ type: 'reply', text: 'Two are busy, sir. The web app is running its tests and the API server is mid-build. The blog and the docs are idle.' });
      if (i % 7 === 0) ev({ type: 'notice', text: 'The web-app session has finished. All tests pass.' });
      if (i % 8 === 4) ev({ type: 'mode', conversation: true }); if (i % 8 === 0) ev({ type: 'mode', conversation: false });
      ev({ type: 'system', cpu: 20 + Math.random() * 30, ram: 68 + Math.random() * 8, ramUsedGB: 12.5, ramTotalGB: 17.2, disk: 89, diskFreeGB: 24, battery: 70, charging: true, uptime: '4d 20h', host: 'macbook' });
    }, 3000);
    setInterval(() => { if (state === 'listening') micLevel = 0.3 + Math.random() * 0.7; if (state === 'speaking') voiceLevel = 0.2 + Math.random() * 0.8; }, 90);
    const wantView = (location.search.match(/view=(\w+)/) || [])[1];
    if (wantView) setTimeout(() => showView(wantView), 1200);
    if (/[?&]open=1/.test(location.search)) setTimeout(() => liveBtn.click(), 2500);
  }
})();
