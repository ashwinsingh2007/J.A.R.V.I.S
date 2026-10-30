// Takes the README and website screenshots from the HUD's demo mode, in the Stark theme.
// Writes docs/screenshots/{home,agents,mesh,memory,sessions,settings}.png.
//
//   node tools/make-shots.mjs [theme]      (needs Google Chrome)
import { chromium } from 'playwright';
import path from 'node:path';
import { assistantsEvent } from './demo-data.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const THEME = process.argv[2] || 'stark';
const W = 1440, H = 900;

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark' });
const open = async () => {
  await page.goto(`file://${ROOT}/src/renderer/hud/index.html?demo=1&tour=1&theme=${THEME}&mode=dark`);
  await page.waitForTimeout(3500);
  await page.evaluate((agents) => {
    window.hud.event(agents);
    window.hud.event({ type: 'state', state: 'speaking' });
    window.hud.event({ type: 'transcript', text: 'what are my sessions doing', final: true });
    window.hud.event({ type: 'reply', text: 'Two are busy, sir. The web app is running its tests and the API server is mid-build.' });
  }, assistantsEvent());
  await page.waitForTimeout(1200);
};
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const view = async (v) => { await page.click(`#nav a[data-view="${v}"]`); await page.waitForTimeout(1500); };
const node = (label) => page.evaluate((l) => [...document.querySelectorAll('#crew .mate')].find((m) => m.textContent.includes(l)).dispatchEvent(new MouseEvent('click', { bubbles: true })), label);

await open();
await shot('home');
await node('MESH');
await page.waitForTimeout(1800);
await shot('mesh');
for (const v of ['agents', 'memory', 'sessions', 'settings']) { await open(); await view(v); await shot(v); }
await browser.close();
console.log('screenshots in', OUT);
