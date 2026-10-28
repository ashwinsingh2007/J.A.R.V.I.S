// Where the clicked group node is, frame by frame, while it flies to the core. Not part of the suites.
import { _electron as electron } from 'playwright';
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-anim-'));
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native' }));
fs.writeFileSync(path.join(state, 's.jsonl'), '');
const app = await electron.launch({ executablePath: path.join(ROOT, 'JARVIS.app/Contents/MacOS/JARVIS'), env: { ...process.env, JARVIS_STATE_DIR: state, JARVIS_TEST_MUTE: '1', JARVIS_EARS_BIN: path.join(ROOT, 'test/fake-ears.js'), JARVIS_FAKE_SPEECH: path.join(state, 's.jsonl'), JARVIS_FAKE_EARS_LOG: path.join(state, 'e.jsonl'), JARVIS_TEST_AUTOHIDE_MS: '600000' } });
let hud; for (let i = 0; i < 60 && !hud; i++) { hud = app.windows().find((w) => /hud\/index/.test(w.url())); if (!hud) await new Promise((r) => setTimeout(r, 500)); }
await hud.waitForFunction(() => !document.body.classList.contains('booting') && !!document.getElementById('crew-g-devices'), null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
const track = await hud.evaluate(() => new Promise((done) => {
  const core = document.getElementById('scene') || document.body;
  const m = document.getElementById('crew-g-devices'), halo = m.querySelector('.halo');
  const out = [], t0 = performance.now();
  m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const step = () => {
    const t = performance.now() - t0;
    const el = document.querySelector('#crew-g-devices .halo');
    const burst = !!document.querySelector('#crew .burst');
    if (el) { const r = el.getBoundingClientRect(); out.push(`${Math.round(t)}ms x=${Math.round(r.x + r.width / 2)} y=${Math.round(r.y + r.height / 2)} w=${Math.round(r.width)} op=${getComputedStyle(el.closest('.mi')).opacity.slice(0, 4)}`); }
    else out.push(`${Math.round(t)}ms ${burst ? 'BURST' : 'gone'} core=${document.querySelector('.corelabel .jv').textContent}`);
    if (t < 900) requestAnimationFrame(step); else done(out);
  };
  requestAnimationFrame(step);
}));
const W = await hud.evaluate(() => [innerWidth / 2, innerHeight / 2]);
console.log('window centre', W.map(Math.round).join(','));
console.log(track.filter((_, i) => i % 3 === 0).join('\n'));
await app.close();
