/* JARVIS Command Center — Three.js core globe + view-switched dashboard.
   Contract: native calls window.hud.event(obj); page posts to webkit.messageHandlers.jarvis. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const DEMO = /[?&]demo=1/.test(location.search) || location.hash === '#demo' || typeof window.webkit === 'undefined';
  const T0 = performance.now();

  // ---------- native bridge ----------
  function post(msg) {
    try { window.webkit.messageHandlers.jarvis.postMessage(msg); } catch (e) { /* not in WKWebView */ }
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

  // ---------- the crew: JARVIS is the main brain inside a loose web of neurons ----------
  // FRIDAY, EDITH, KAREN and VISION are larger nodes in that web; signals run to each of them from the brain
  // along the shortest chain of neurons. Each one fires while it has jobs running.
  const HUBS = [
    { id: 'edith', name: 'EDITH', role: 'SECURITY', x: 21, y: -53 },
    { id: 'karen', name: 'KAREN', role: 'MESSAGES', x: 73, y: 24 },
    { id: 'friday', name: 'FRIDAY', role: 'TASKS', x: -79, y: -14 },
    { id: 'vision', name: 'VISION', role: 'BROWSER', x: -38, y: 50 },
  ];
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
      return `<g class="mate" id="crew-${h.id}" style="--i:${n}">`
        + (d ? `<path class="fire" d="${d}" style="--d:${f(rnd())}s"/>` : '') + sparks
        + `<circle class="halo" cx="${f(h.x)}" cy="${f(h.y)}" r="3.4"/><circle class="ring" cx="${f(h.x)}" cy="${f(h.y)}" r="2.1"/><circle class="core" cx="${f(h.x)}" cy="${f(h.y)}" r="1.05"/>`
        + `<text class="nm" text-anchor="${anchor}" x="${f(lx)}" y="${f(h.y - 0.3)}">${h.name}</text>`
        + `<text class="rl" text-anchor="${anchor}" x="${f(lx)}" y="${f(h.y + 2.6)}">${h.role} · STANDBY</text></g>`;
    }).join('');
    return `<g class="field">${field}</g>${mates}`;
  }
  function setCrew(counts) {
    HUBS.forEach((h) => {
      const el = $('crew-' + h.id), n = (counts && counts[h.id]) || 0;
      el.classList.toggle('on', n > 0);
      el.querySelector('.rl').textContent = `${h.role} · ${n > 0 ? n + ' RUNNING' : 'STANDBY'}`;
    });
  }

  // ---------- animation loop ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  let last = performance.now(), spinA = 0, tAcc = 0, nextBolt = 1.5;
  const tmp = new THREE.Color();

  function frame(now) {
    requestAnimationFrame(frame);
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
      arr[i].style.height = (2 + v * maxH) + 'px';
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
    $('power').querySelector('b').textContent = disabled ? 'ENABLE JARVIS' : 'DISABLE JARVIS'; $('power').classList.toggle('off', disabled); document.body.classList.toggle('disabled', disabled);
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
  // ---------- right panel: conversations (JARVIS, the crew, Claude Code sessions) ----------
  const livelog = $('livelog');
  const CREW_IDS = ['friday', 'karen', 'edith', 'vision'];
  const CREW_ROLE = { friday: 'tasks', karen: 'messages', edith: 'security', vision: 'browser' };
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
      e.textContent = c.key === 'jarvis' ? 'NO CONVERSATION YET' : c.key.startsWith('cc:') ? 'NO MESSAGES YET' : `NOTHING ASKED OF ${c.name} YET`;
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
    const crewNow = (liveNow && liveNow.crew) || {};
    grp('JARVIS');
    add('JARVIS', stats.brainReady ? 'idle' : '', 'jarvis', 'you and JARVIS');
    CREW_IDS.forEach((id) => add(id.toUpperCase(), crewNow[id] ? 'working' : 'idle', id, crewNow[id] ? `${crewNow[id]} running` : CREW_ROLE[id]));
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
    ul.replaceChildren(...(facts.length ? [...facts].reverse().map((f) => memRow(f.text, (f.topic && f.topic !== 'other' ? f.topic.toUpperCase() + ' · ' : '') + String(f.added || '').slice(0, 10),
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
    setCrew(stats.crew || (ag.length ? { friday: ag.length } : {}));
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
  window.hud = {
    event(e) {
      if (!e || !e.type) return;
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
        case 'schedule': setSchedule(e.data); break;
        case 'info': Object.assign(info, e); setStats({}); break;
        case 'theme': jarvisTheme.apply(e.theme, e.mode); break;
        case 'settings': setSettings(e); if (window.jarvisSettings) window.jarvisSettings.event(e); break;
        case 'open-settings': showView('settings'); if (window.jarvisSettings) window.jarvisSettings.open(e.section || ''); break;
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
    },
  };

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
    const ns = document.querySelector('[data-key="nativeVoice"]');
    if (Array.isArray(e.sayVoices) && e.sayVoices.length) {
      ns.replaceChildren(...e.sayVoices.map((v) => { const o = document.createElement('option'); o.value = o.textContent = v; return o; }));
    }
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
  // The big choices: what is set now, and a button into the Settings window at that section.
  const setVals = {};
  function renderSetCards(e) {
    Object.assign(setVals, e.values || {});
    if ('brain' in e) setVals.brain = e.brain;
    if ('workerAvailable' in e) setVals.workerAvailable = e.workerAvailable;
    if (e.hands) setVals.hands = e.hands;
    const v = setVals, up = (s) => String(s || '—').toUpperCase();
    const cc = /^claude code/.test(v.brain || '');
    const worker = cc ? `AGENTS · ${up(v.agentModel)}` : v.workerAvailable && v.worker !== 'off' ? `FRIDAY · ${up(v.agentModel)}` : 'NO WORKER';
    $('sc-brain').textContent = `${up(v.brain)} · ${worker}`;
    const h = v.hands || {};
    $('sc-access').textContent = h.missing ? 'MIC · SPEECH' : `MIC · SPEECH · APPS ${h.ax ? '✓' : '✗'} · SCREEN ${h.screen ? '✓' : '✗'}`;
    $('sc-ears').textContent = v.sttEngine === 'elevenlabs' ? 'ELEVENLABS SCRIBE' : `ON-DEVICE · ${up(v.speechLocale)}`;
    $('sc-voice').textContent = { kokoro: `KOKORO · ${up(v.kokoroVoice)}`, elevenlabs: 'ELEVENLABS', edge: `EDGE · ${up(v.edgeVoice)}`, native: `MACOS · ${up(v.nativeVoice)}` }[v.ttsEngine] || up(v.ttsEngine);
    $('sc-extras').textContent = `TELEGRAM ${stats.telegram && stats.telegram !== 'off' ? up(stats.telegram) : 'OFF'}`;
  }
  // Each card opens its page inside the Settings box (settings.js).
  document.querySelectorAll('.setcard').forEach((b) => b.addEventListener('click', () => window.jarvisSettings && window.jarvisSettings.open(b.dataset.section)));

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
      const busy = body.dataset.view !== 'cc' || !livePop.hidden || document.activeElement?.matches('input, select, textarea');
      if (busy) focus.timer = setTimeout(tryFocus, focus.ms);
      else body.classList.add('focus');
    }, focus.ms);
  }
  for (const type of ['mousemove', 'mousedown', 'wheel', 'keydown']) document.addEventListener(type, armFocus, { passive: true });
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
    if (askInput.value) askInput.value = ''; else askInput.blur();
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

  document.addEventListener('keydown', (ev) => { if (ev.key !== 'Escape') return; if (!livePop.hidden) { livePop.hidden = true; return; } post({ type: 'action', name: 'stop' }); });

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
    ev({ type: 'stats', turns: 22, toolCalls: 14, memories: 38, sessionsActive: 2, brainModel: 'opus', effort: 'low', brainReady: true, tts: 'kokoro bm_george', stt: 'apple on-device', telegram: '@my_jarvis_bot', agents: ['checking your Gmail'], crew: { karen: 1 } });
    ev({ type: 'system', cpu: 36, ram: 72, ramUsedGB: 12.5, ramTotalGB: 17.2, disk: 89, diskFreeGB: 24, battery: 70, charging: true, uptime: '4d 20h', host: 'macbook' });
    ev({ type: 'history', data: [
      { t: '09:30', you: 'what are my sessions doing', jarvis: 'Two are busy, sir. The web app is running its tests and the API server is mid-build. The blog and the docs are idle.' },
      { t: '10:12', you: 'open netflix in chrome', jarvis: 'Netflix is open in Chrome.' },
      { t: '11:02', you: 'check my gmail for today', jarvis: 'Opening your inbox now. I\'ll tell you what needs a reply.' },
      { t: '11:06', you: '(agent)', jarvis: 'Three new emails. Only the one from your landlord needs a reply today.' },
      { t: '11:18', you: 'remind me at five to call the bank', jarvis: 'Done. I\'ll remind you at five.' },
    ] });
    ev({ type: 'memory', data: [
      { id: 'm1', text: 'Prefers lo-fi music while working.', topic: 'preference', added: '2026-10-21T09:12' },
      { id: 'm2', text: 'Lives in Bengaluru and works from home on Fridays.', topic: 'place', added: '2026-10-22T18:40' },
      { id: 'm3', text: 'Sister is called Priya; her birthday is on 14 November.', topic: 'person', added: '2026-10-23T20:05' },
      { id: 'm4', text: '"The web app" means the project in ~/Projects/web-app.', topic: 'project', added: '2026-10-24T11:30' },
      { id: 'm5', text: 'Goes for a run most mornings around seven.', topic: 'routine', added: '2026-10-24T07:55' },
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
      { t: '19:56', who: 'jarvis', name: 'JARVIS', text: "KAREN's going through your inbox now, sir." },
      { t: '19:58', who: 'jarvis', name: 'JARVIS', text: 'Three new emails. Only the one from your bank needs a reply.' },
      { t: '20:01', who: 'you', name: 'YOU', text: 'Draft a polite reply saying I will call them tomorrow.' },
      { t: '20:01', who: 'jarvis', name: 'JARVIS', text: 'Drafting it now. I will read it to you before anything is sent.' },
    ];
    let tailN = 2;
    setInterval(() => { tailN = Math.min(tailEntries.length, tailN + 1); ev({ type: 'conversation', key: 'jarvis', name: 'JARVIS', status: tailN < tailEntries.length ? 'working' : 'idle', ago: '', crew: { karen: 1 }, entries: tailEntries.slice(0, tailN) }); }, 1500);
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
