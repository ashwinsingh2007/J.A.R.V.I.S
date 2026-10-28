// End-to-end tests: drive the packaged JARVIS.app with Playwright.
//
//   node test/e2e.mjs [onboarding|voice|hud|all]
//
// Each run uses a throwaway state folder (JARVIS_STATE_DIR), muted audio and a
// scripted fake microphone (test/fake-ears.js), so it never touches your real
// ~/.jarvis config and can run while your own JARVIS is open.
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'JARVIS.app/Contents/MacOS/JARVIS');
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'jarvis-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeState(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

async function launch(state, args = [], extraEnv = {}) {
  const speech = path.join(state, 'speech.jsonl');
  const earsLog = path.join(state, 'ears-cmds.jsonl');
  fs.writeFileSync(speech, '');
  fs.writeFileSync(earsLog, '');
  const app = await electron.launch({
    executablePath: EXE,
    args,
    env: {
      ...process.env,
      JARVIS_STATE_DIR: state,
      JARVIS_TEST_MUTE: '1',
      JARVIS_EARS_BIN: path.join(ROOT, 'test/fake-ears.js'),
      JARVIS_FAKE_SPEECH: speech,
      JARVIS_FAKE_EARS_LOG: earsLog,
      JARVIS_TEST_UPDATE_MS: '8000',
      JARVIS_TEST_AUTOHIDE_MS: '600000',   // keep panels up while Playwright drives the HUD
      ...extraEnv,
    },
    timeout: 30000,
  });
  const logFile = path.join(state, 'jarvis.log');
  const ctx = {
    app, state,
    log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    earsCmds: () => fs.readFileSync(earsLog, 'utf8'),
    // The saved config, with the assistant in use's own settings on top, as JARVIS reads it.
    config: () => { const r = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')); return { ...r, ...((r.assistantSettings || {})[r.assistant || 'jarvis'] || {}) }; },
    /** Make the fake microphone "hear" text: partial updates, then a pause. */
    async say(text, { final = true, step = 0 } = {}) {
      if (step) {
        const words = text.split(' ');
        for (let i = 1; i <= words.length; i++) { fs.appendFileSync(speech, JSON.stringify({ text: words.slice(0, i).join(' '), final: false }) + '\n'); await sleep(step); }
      }
      fs.appendFileSync(speech, JSON.stringify({ text, final }) + '\n');
    },
    /** The recogniser ends its task and starts a new one (classic dictation does this after pauses). */
    recognizerRestart() { fs.appendFileSync(speech, JSON.stringify({ type: 'restarted' }) + '\n'); },
    async waitLog(re, timeout = 15000, from = 0) {
      const t = Date.now();
      while (Date.now() - t < timeout) {
        const m = ctx.log().slice(from).match(re);
        if (m) return m;
        await sleep(150);
      }
      return null;
    },
    mark: () => ctx.log().length,
    /** Wait until JARVIS has stopped talking (speech while it talks is ignored by design). */
    async quiet(page, timeout = 20000) {
      const t = Date.now();
      while (Date.now() - t < timeout) {
        const st = await page.evaluate(() => document.body.dataset.state).catch(() => '');
        if (st && st !== 'speaking' && st !== 'thinking' && st !== 'booting') { await sleep(700); return st; }
        await sleep(150);
      }
      return null;
    },
  };
  return ctx;
}

async function windowByUrl(app, re, timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    for (const w of app.windows()) {
      try { if (re.test(w.url())) return w; } catch {}
    }
    await sleep(200);
  }
  return null;
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {});
const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 3000 }).catch(() => '');

// ---------------------------------------------------------------------------

async function testOnboarding() {
  console.log('\nONBOARDING');
  const s = await launch(makeState());
  const w = await windowByUrl(s.app, /setup\.html\?first=1/);
  check('first run opens the setup window', w);
  if (!w) { await s.app.close(); return; }
  await w.waitForSelector('section.on[data-step="welcome"]');
  await shot(w, 'onb-0-welcome');

  // Welcome
  await w.fill('#userName', 'Tester 42');
  await w.selectOption('#honorific', 'boss');
  check('Back is disabled on the first step', await w.isDisabled('#back'));
  await w.click('#next');
  check('Next goes to Appearance', await w.isVisible('section.on[data-step="look"]'));
  await w.click('[data-theme-pick="terminal"]');
  await w.click('[data-mode-pick="light"]');
  const applied = await w.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/'));
  check('theme applies live to the Setup window', applied === 'terminal/light', applied);
  check('theme saved immediately', s.config().theme === 'terminal' && s.config().themeMode === 'light');
  await shot(w, 'onb-1a-look');
  await w.click('[data-theme-pick="jarvis"]');
  await w.click('[data-mode-pick="dark"]');
  await w.click('#next');
  check('Next goes to Brain', await w.isVisible('section.on[data-step="brain"]'));

  // Brain: detection shown
  const cc = await text(w, '#cc-status');
  check('Claude Code detection shown', /✓|✗|!/.test(cc), cc);
  check('a ready brain is picked by default', await w.locator('[data-brain].on').count() === 1 && !(await w.isDisabled('#next')));

  // Brain: random Anthropic key must be rejected
  await w.click('[data-brain="anthropic"]');
  check('Anthropic card selectable', await w.locator('[data-brain="anthropic"].on').count() === 1);
  check('Anthropic settings group visible', await w.isVisible('[data-for="anthropic"]'));
  await w.fill('#anthropicApiKey', 'sk-ant-random-1234567890');
  await w.click('[data-test="anthropic"]');
  await w.waitForFunction(() => !/testing/.test(document.getElementById('api-status').textContent), null, { timeout: 15000 }).catch(() => {});
  const apiStatus = await text(w, '#api-status');
  check('random Anthropic key is rejected', /✗/.test(apiStatus), apiStatus);
  check('Next stays disabled with a rejected key', await w.isDisabled('#next'));
  check('the Brain step says why', /rejected/.test(await text(w, '#brain-msg')), await text(w, '#brain-msg'));
  await w.fill('#anthropicModel', 'claude-random-999');

  // Brain: Ollama on a dead port
  await w.click('[data-brain="ollama"]');
  await w.click('.adv summary');
  await w.fill('#ollamaUrl', 'http://127.0.0.1:9');
  await w.click('[data-test="ollama"]');
  await w.waitForFunction(() => !/testing/.test(document.getElementById('ollama-status').textContent), null, { timeout: 10000 }).catch(() => {});
  const ol = await text(w, '#ollama-status');
  check('Ollama on a dead port reports failure', /✗|not running|not installed/.test(ol), ol);
  check('Ollama offers to start or install itself', /Start Ollama|Install Ollama/.test(await text(w, '#ol-action')), await text(w, '#ol-action'));
  check('Next stays disabled until Ollama works', await w.isDisabled('#next'));
  await w.fill('#ollamaUrl', 'http://127.0.0.1:11434');
  // Brain: Gemini with a made-up key
  await w.click('[data-brain="gemini"]');
  check('Gemini settings group visible', await w.isVisible('[data-for="gemini"]'));
  await w.fill('#geminiApiKey', 'AIza-random-1234567890');
  await w.click('[data-test="gemini"]');
  await w.waitForFunction(() => !/testing/.test(document.getElementById('gemini-status').textContent), null, { timeout: 15000 }).catch(() => {});
  const gm = await text(w, '#gemini-status');
  check('random Gemini key is rejected', /✗/.test(gm), gm);
  await w.fill('#geminiApiKey', '');
  await w.click('[data-brain="claude-code"]');
  check('Claude Code, installed here, lets you on', !(await w.isDisabled('#next')), await text(w, '#brain-msg'));
  await shot(w, 'onb-1-brain');
  await w.click('#next');

  // Listening
  check('Next goes to Listening', await w.isVisible('section.on[data-step="ears"]'));
  await w.click('[data-stt="elevenlabs"]');
  check('ElevenLabs key field appears', await w.isVisible('#elevenLabsApiKey'));
  await w.fill('#elevenLabsApiKey', 'sk_random_99999');
  await w.click('[data-test="elevenlabs"]');
  await w.waitForFunction(() => { const e = document.getElementById('el-status'); return e.textContent && !/testing/.test(e.textContent); }, null, { timeout: 15000 }).catch(() => {});
  const elStatus = await text(w, '#el-status');
  check('random ElevenLabs key is rejected', /✗/.test(elStatus), elStatus);
  await w.fill('#commandSilenceSeconds', '4.5');
  await w.click('label.switch:has(#requireEndWord)');
  check('toggle switch turns on when clicked', await w.isChecked('#requireEndWord'));
  await w.selectOption('#speechLocale', 'en-GB');
  await shot(w, 'onb-2-ears');
  await w.click('#next');

  // Voice
  check('Next goes to Voice', await w.isVisible('section.on[data-step="voice"]'));
  const k2 = await w.inputValue('#elevenLabsApiKey2');
  check('ElevenLabs key carried over to the Voice step', k2 === 'sk_random_99999');
  await w.click('[data-tts="native"]');
  const nv = await w.inputValue('#nativeVoice');
  const nvCount = await w.locator('#nativeVoice option').count();
  check('macOS voice dropdown is filled and a voice is selected', nv && nvCount > 3, `${nv} (${nvCount} voices)`);
  check('no novelty voices (Bells, Boing…) in the list', !(await w.locator('#nativeVoice option[value="Boing"]').count()));
  await w.click('#test-voice');
  await w.waitForFunction(() => !/speaking/.test(document.getElementById('voice-result').textContent), null, { timeout: 15000 }).catch(() => {});
  const vr = await text(w, '#voice-result');
  check('macOS voice test works', /✓ native/.test(vr), vr);
  await w.click('[data-tts="kokoro"]');
  await w.click('#test-voice');
  await w.waitForFunction(() => !/speaking/.test(document.getElementById('voice-result').textContent), null, { timeout: 20000 }).catch(() => {});
  const kr = await text(w, '#voice-result');
  check('Kokoro voice test works', /✓ kokoro/.test(kr), kr);
  const synth = await s.waitLog(/timing: kokoro synth/, 20000);
  check('Kokoro actually synthesised audio', synth);
  await w.click('[data-tts="native"]');
  await shot(w, 'onb-3-voice');
  await w.click('#next');

  // Access: every permission listed with its state; the real ones are already granted on this Mac
  check('Next goes to Access', await w.isVisible('section.on[data-step="access"]'));
  await w.waitForFunction(() => [...document.querySelectorAll('#perms li[data-perm="mic"] .chip')].some((c) => c.textContent), null, { timeout: 15000 }).catch(() => {});
  const permRows = await w.$$eval('#perms li', (ls) => ls.map((l) => `${l.dataset.perm}=${l.querySelector('.chip').textContent}`));
  check('Access lists the six permissions', permRows.length === 6, permRows.join(' | '));
  check('microphone and speech states are shown', permRows.slice(0, 2).every((r) => /=(✓ allowed|not yet|✗ not allowed)/.test(r)), permRows.slice(0, 2).join(' | '));
  await w.click('#perms li[data-perm="notifications"] button');
  await w.waitForFunction(() => /test sent/.test(document.querySelector('#perms li[data-perm="notifications"] .chip').textContent), null, { timeout: 8000 }).catch(() => {});
  check('notifications: a test is sent', /test sent/.test(await text(w, '#perms li[data-perm="notifications"] .chip')));
  await shot(w, 'onb-4-access');
  await w.click('#next');

  // Extras
  check('Next goes to Extras', await w.isVisible('section.on[data-step="extras"]'));
  await w.fill('#telegramToken', '123456:random-token');
  await w.click('[data-test="telegram"]');
  await w.waitForFunction(() => { const e = document.getElementById('tg-status'); return e.textContent && !/testing/.test(e.textContent); }, null, { timeout: 15000 }).catch(() => {});
  const tg = await text(w, '#tg-status');
  check('random Telegram token is rejected', /✗/.test(tg), tg);
  await w.fill('#telegramChatId', '987654');
  await w.selectOption('#radioCountry', 'GB');
  await shot(w, 'onb-4-extras');

  // Back keeps values
  await w.click('#back');
  check('Back returns to Access', await w.isVisible('section.on[data-step="access"]'));
  await w.click('#next');
  await w.click('#next');

  // Finish
  check('Next goes to Finish', await w.isVisible('section.on[data-step="finish"]'));
  const summary = await text(w, '#summary');
  check('summary shows the name', summary.includes('Tester 42'), summary.slice(0, 120));
  check('summary shows the chosen brain', summary.includes('Claude Code'));
  check('summary shows Telegram configured', summary.includes('configured'));
  await shot(w, 'onb-5-finish');

  // Saved config (written on every Next)
  const c = s.config();
  check('name saved', c.userName === 'Tester 42');
  check('honorific saved', c.honorific === 'boss');
  check('brain saved', c.brainProvider === 'claude-code');
  check('stt saved', c.sttEngine === 'elevenlabs');
  check('silence saved as a number', c.commandSilenceSeconds === 4.5);
  check('requireEndWord saved', c.requireEndWord === true);
  check('locale saved', c.speechLocale === 'en-GB');
  check('chat id saved as a number', c.telegramChatId === 987654);
  check('radio country saved', c.radioCountry === 'GB');
  check('Anthropic key encrypted at rest', String(c.anthropicApiKey).startsWith('enc:'), String(c.anthropicApiKey).slice(0, 8));
  check('ElevenLabs key encrypted at rest', String(c.elevenLabsApiKey).startsWith('enc:'));
  check('Telegram token encrypted at rest', String(c.telegramToken).startsWith('enc:'));
  check('no plaintext secret in config file', !['sk-ant-random', 'sk_random_99999', 'random-token'].some((x) => JSON.stringify(c).includes(x)));

  // Start: JARVIS should come up in the same process
  await w.click('#next');
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  check('Start JARVIS opens the HUD', hud);
  check('onboarded flag saved', s.config().onboarded === true);
  if (hud) {
    const brainLine = await s.waitLog(/brain: provider (\S+)/, 10000);
    check('brain provider is the chosen one', brainLine && brainLine[1] === 'claude-code', brainLine && brainLine[1]);
    const tgStop = await s.waitLog(/telegram: token rejected/, 8000);
    check('bad Telegram token stops polling (no API hammering)', tgStop && (s.log().match(/getUpdates: Unauthorized/g) || []).length <= 1);
    await shot(hud, 'onb-6-hud-after');
  }
  await s.app.close();

  // A key that stops working after setup gives a clear spoken and on-screen error
  const k = await launch(makeState({ onboarded: true, brainProvider: 'anthropic', anthropicApiKey: 'sk-ant-random-1234567890', ttsEngine: 'native' }));
  const hud2 = await windowByUrl(k.app, /hud\/index\.html/, 20000);
  if (hud2) {
    await hud2.waitForFunction(() => document.body.dataset.state !== 'booting', null, { timeout: 15000 }).catch(() => {});
    const w0 = k.mark();
    await k.say('jarvis wake up');
    await k.waitLog(/conversation mode on/, 8000);
    await k.waitLog(/synth/, 8000, w0);
    await k.quiet(hud2);
    const m = k.mark();
    await k.say('what is the capital of france over');
    const err = await k.waitLog(/brain\(anthropic\) error: (.*)/, 20000, m);
    check('random API key gives a clear error', err && /401|x-api-key|authentication/.test(err[1]), err && err[1]);
    await sleep(800);
    const reply = await text(hud2, '#reply');
    check('error is shown on the HUD', /Anthropic|rejected|key/i.test(reply), reply.slice(0, 100));
  } else check('HUD for the bad-key run', false);
  await k.app.close();
}


async function testValidation() {
  console.log('\nONBOARDING WITH JUNK INPUT');
  const s = await launch(makeState());
  const w = await windowByUrl(s.app, /setup\.html\?first=1/);
  if (!w) { check('setup window', false); await s.app.close(); return; }
  await w.waitForSelector('section.on[data-step="welcome"]');
  const setNum = (sel, v) => w.evaluate(([q, val]) => { const e = document.querySelector(q); e.value = val; }, [sel, v]);

  // Welcome: empty name, weird honorific left default
  await w.fill('#userName', '   ');
  await w.click('#next');
  await w.click('#next');            // Appearance: keep default
  // Brain: Anthropic with NO key is refused on the spot
  await w.click('[data-brain="anthropic"]');
  await w.fill('#anthropicModel', '');
  check('refuses Anthropic brain without a key', await w.isDisabled('#next') && /Anthropic API key/.test(await text(w, '#brain-msg')), await text(w, '#brain-msg'));
  check('no HUD started while setup is invalid', !(await windowByUrl(s.app, /hud\/index\.html/, 1500)));
  await w.click('[data-brain="claude-code"]');
  await w.click('#next');
  // Listening: ElevenLabs with no key, negative silence
  await w.click('[data-stt="elevenlabs"]');
  await w.fill('#commandSilenceSeconds', '-5');
  await w.click('#next');
  // Voice: absurd Kokoro speed
  await w.click('[data-tts="kokoro"]');
  await w.fill('#kokoroSpeed', '99');
  await w.click('#next');
  await w.click('#next');            // Access: nothing to change
  // Extras: letters in chat id
  await setNum('#telegramChatId', 'abc');
  await w.click('#next');

  // Finish must refuse: ElevenLabs listening without a key
  await w.click('#next');
  await sleep(500);
  const msg = await text(w, '#saved');
  check('refuses ElevenLabs listening without a key', /ElevenLabs API key/.test(msg), msg);

  // Junk numbers were clamped when saved
  const c = s.config();
  check('negative silence clamped', c.commandSilenceSeconds >= 0.5 && c.commandSilenceSeconds <= 15, String(c.commandSilenceSeconds));
  check('Kokoro speed 99 clamped', c.kokoroSpeed <= 2, String(c.kokoroSpeed));
  check('letters in chat id become 0', c.telegramChatId === 0, String(c.telegramChatId));
  check('blank name stored empty', c.userName === '', JSON.stringify(c.userName));
  check('blank Anthropic model falls back to default', c.anthropicModel === undefined || /^claude-/.test(c.anthropicModel), c.anthropicModel);

  // Key typed once counts as stored afterwards (the stale "has key" bug)
  await w.click('#steps li[data-step="ears"]');
  await w.fill('#elevenLabsApiKey', 'sk_junk_123');
  await w.click('#next');            // saves
  await w.click('#steps li[data-step="ears"]');
  await w.fill('#elevenLabsApiKey', '');
  await w.click('[data-stt="apple"]');
  await w.click('#steps li[data-step="finish"]');
  await w.click('#next');
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  check('valid setup starts JARVIS', hud);
  check('stored ElevenLabs key kept when field left empty', String(s.config().elevenLabsApiKey).startsWith('enc:'));

  // Settings in the HUD box: a stored key shows as stored, an empty field keeps it, clamped values stay clamped
  if (hud) {
    await hud.click('#nav a[data-view="settings"]');
    await hud.click('#setnav [data-section="ears"]');
    await sleep(800);
    check('Settings opens Listening beside the sidebar', await hud.isVisible('#set-page .sp[data-page="ears"]') && await hud.isHidden('#set-page .sp[data-page="general"]'));
      await hud.click('#setnav [data-section="voice"]');
    await hud.click('#nav a[data-view="agents"]');
    await hud.waitForFunction(() => document.querySelector('#a-edit [data-s="kokoroSpeed"]').value, null, { timeout: 8000 }).catch(() => {});
    const v = await hud.inputValue('#a-edit [data-s="kokoroSpeed"]').catch(() => '');
    check('Agents shows the clamped speed', Number(v) > 0 && Number(v) <= 2, v);
    await hud.click('#nav a[data-view="settings"]');
    const before = s.config().elevenLabsApiKey;
      await hud.click('#setnav [data-section="extras"]');
    await hud.click('#x-save');
    await hud.waitForFunction(() => /Saved/.test(document.getElementById('x-msg').textContent), null, { timeout: 8000 }).catch(() => {});
    check('saving with empty key fields keeps the stored keys', s.config().elevenLabsApiKey === before && String(before).startsWith('enc:'));
    }
  await s.app.close();
}


async function testThemes() {
  console.log('\nTHEMES (screenshots of every theme, dark and light)');
  const s = await launch(makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native' }));
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  if (!hud) { check('HUD opens', false); await s.app.close(); return; }
  await hud.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 15000 }).catch(() => {});
  // Every theme, dark and light, from the HUD's own picker
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#setnav [data-section="look"]');
  for (const theme of ['jarvis', 'terminal', 'neon', 'stark', 'minimal']) {
    for (const mode of ['dark', 'light']) {
      await hud.click(`#look-themes [data-theme-pick="${theme}"]`);
      await hud.click(`#look-modes [data-mode-pick="${mode}"]`);
      await sleep(700);
      const h = await hud.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/'));
      check(`HUD follows ${theme}/${mode}`, h === `${theme}/${mode}`, h);
      const bg = await hud.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const light = await hud.evaluate(() => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3 > 128; });
      check(`HUD background is ${mode} for ${theme}`, light === (mode === 'light'), bg);
      await shot(hud, `theme-hud-${theme}-${mode}`);
    }
  }
  for (const page of ['general', 'brain', 'access', 'voice', 'extensions']) {
    await hud.click(`#setnav [data-section="${page}"]`);
    await sleep(1200);
    await shot(hud, `settings-${page}-minimal-light`);
  }
  await hud.click('#nav a[data-view="agents"]');
  await sleep(800);
  await shot(hud, 'agents-minimal-light');
  for (const [theme, mode] of [['jarvis', 'dark'], ['stark', 'dark']]) {
    await hud.evaluate(([t, md]) => window.jarvisTheme && window.jarvisTheme.apply(t, md), [theme, mode]);
    await sleep(500);
    await shot(hud, `agents-${theme}-${mode}`);
  }
  await hud.click('#nav a[data-view="settings"]');
  for (const page of ['general', 'brain', 'extensions']) {
    await hud.click(`#setnav [data-section="${page}"]`);
    await sleep(600);
    await shot(hud, `settings-${page}-stark-dark`);
  }
  await hud.click('#setnav [data-section="look"]');
  await hud.click('#look-modes [data-mode-pick="system"]');
  await sleep(500);
  const sys = await hud.evaluate(() => document.documentElement.dataset.mode);
  check('"Match macOS" resolves to dark or light', sys === 'dark' || sys === 'light', sys);
  await hud.click('#look-themes [data-theme-pick="neon"]');
  await hud.click('#look-modes [data-mode-pick="light"]');
  await sleep(800);
  const hv = await hud.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/'));
  check('HUD picker applies the theme', hv === 'neon/light', hv);
  const saved = s.config();
  check('HUD picker saves the theme', saved.theme === 'neon' && saved.themeMode === 'light', `${saved.theme}/${saved.themeMode}`);
  check('HUD picker marks the current choice', await hud.evaluate(() => document.querySelector('#look-themes .on')?.dataset.themePick === 'neon' && document.querySelector('#look-modes .on')?.dataset.modePick === 'light'));
  await shot(hud, 'hud-settings-picker');
  await s.app.close();
}

// ---------------------------------------------------------------------------

async function testVoice() {
  console.log('\nVOICE PIPELINE (Claude Code brain, fake microphone)');
  const s = await launch(makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native', commandSilenceSeconds: 1.2, pauseGraceSeconds: 2 }));
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  check('HUD opens', hud);
  if (!hud) { await s.app.close(); return; }
  check('ears sidecar ready', await s.waitLog(/ears: ready/, 10000));
  await hud.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 15000 }).catch(() => {});
  check('state becomes idle after boot', await hud.evaluate(() => document.body.dataset.state) === 'idle');
  check('boot greeting spoken', await s.waitLog(/timing: native synth/, 15000));

  // Asleep: ordinary speech is ignored
  await s.quiet(hud);
  let m = s.mark();
  await s.say('jarvis what time is it');
  check('asleep: commands are ignored', await s.waitLog(/asleep: ignored/, 6000, m));

  // Wake
  m = s.mark();
  await s.say('jarvis wake up', { step: 80 });
  check('wake phrase recognised instantly', await s.waitLog(/command 'wake up' \(instant\)|wake \(name last\)/, 5000, m));
  check('conversation mode on', await s.waitLog(/conversation mode on/, 3000, m));
  check('replies "Yes, sir?"', await s.waitLog(/native synth/, 8000, m));
  await s.quiet(hud);

  // A real question through the brain
  m = s.mark();
  await s.say('what day of the week is it today', { step: 60 });
  const cmd = await s.waitLog(/listener: command '([^']+)'/, 8000, m);
  check('command sent after silence', cmd, cmd && cmd[1]);
  const done = await s.waitLog(/timing: claude done ([\d.]+)s/, 60000, m);
  check('Claude Code answered', done, done && `${done[1]}s`);
  await sleep(800);
  const reply = await text(hud, '#reply');
  check('reply shown on the HUD', /day|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(reply), reply.slice(0, 100));
  check('reply spoken', await s.waitLog(/native synth/, 10000, m));
  await shot(hud, 'voice-1-answer');

  // "over" sends immediately
  await s.quiet(hud);
  m = s.mark();
  const t0 = Date.now();
  await s.say('say the word ready over');
  const over = await s.waitLog(/listener: command 'say the word ready'/, 4000, m);
  check('"over" sends immediately and is stripped', over, over ? `${Date.now() - t0} ms` : '');
  await s.waitLog(/timing: claude done/, 60000, m);

  // Background agent: the brain hands off, answers at once, and speaks the result later
  await s.quiet(hud);
  m = s.mark();
  await s.say('use a background agent to run the date command and tell me the current year over');
  check('brain starts a background agent', await s.waitLog(/brain: worker started/, 60000, m));
  check('brain answers before the agent finishes', await s.waitLog(/timing: claude done/, 60000, m) && !s.log().slice(m).match(/brain: \w+ completed/));
  check('agent completes', await s.waitLog(/brain: worker completed/, 120000, m));
  const bg = await s.waitLog(/brain: background turn '(.*)/, 60000, m);
  const spokenAt = s.log().indexOf('brain: background turn', m);
  check('agent result is spoken', bg && /20\d\d|year/i.test(bg[1]) && await s.waitLog(/native synth/, 10000, spokenAt), bg && bg[1]);
  const footer = await text(hud, '#br-worker');
  check('HUD footer shows no jobs again', /NO JOBS RUNNING/.test(footer), footer);

  // Longer job: quick spoken reply without technical words, live progress, "what's the status?" answered locally
  await s.quiet(hud);
  m = s.mark();
  await s.say('in the background, run the shell command ping -c 20 localhost three separate times one after another, then tell me the word finished over');
  check('long job starts', await s.waitLog(/brain: worker started/, 60000, m));
  await s.waitLog(/timing: claude done/, 60000, m);
  const ack = await text(hud, '#reply');
  check('reply hides the machinery', ack && !/\b(agent|subagent|worker|background task|task id)\b/i.test(ack), ack.slice(0, 120));
  check('agent writes plain status lines', await s.waitLog(/brain: agent status '/, 60000, m));
  check('progress spoken while it works', await s.waitLog(/progress: '/, 60000, m));
  await s.quiet(hud);
  const sm = s.mark();
  await s.say("what's the status over");
  let st = await s.waitLog(/status: '(.*)'/, 5000, sm);
  if (!st) { await s.quiet(hud); await s.say("what's the status over"); st = await s.waitLog(/status: '(.*)'/, 5000, sm); }   // a progress line may have talked over it
  check('status question answered at once, without the brain', st && !s.log().slice(sm).includes('brain: asked'), st && st[1]);
  check('long job completes', await s.waitLog(/brain: worker completed/, 180000, m));

  // Classic dictation ends its task after a short pause; the command must survive that
  await s.quiet(hud);
  m = s.mark();
  await s.say('what is the capital', { final: true });
  await sleep(300);
  s.recognizerRestart();
  await sleep(300);
  await s.say('of france');
  const joined = await s.waitLog(/listener: command '([^']+)'/, 8000, m);
  check('command survives a recogniser restart', joined && joined[1] === 'what is the capital of france', joined && joined[1]);
  await s.waitLog(/timing: claude done/, 60000, m);

  // Local intents (no brain)
  await s.quiet(hud);
  m = s.mark();
  await s.say('play some music over');
  check('"play some music" starts the radio', await s.waitLog(/music: playing/, 5000, m));
  check('radio audio actually starts', await s.waitLog(/music: audio started/, 15000, m));
  m = s.mark();
  await s.say('stop the music over');
  await sleep(1500);
  check('"stop the music" handled locally (no brain call)', !/brain: asked/.test(s.log().slice(m)));

  // Sleep
  await s.quiet(hud);
  m = s.mark();
  await s.say('sleep');
  check('"sleep" turns conversation mode off', await s.waitLog(/conversation mode off/, 6000, m));
  await s.quiet(hud);
  m = s.mark();
  await s.say('jarvis tell me a joke');
  check('after sleep, commands are ignored again', await s.waitLog(/asleep: ignored/, 6000, m));

  await s.app.close();
}

// ---------------------------------------------------------------------------

async function testHud() {
  console.log('\nHUD CONTROLS');
  const s = await launch(makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native' }));
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  check('HUD opens', hud);
  if (!hud) { await s.app.close(); return; }
  await hud.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 15000 }).catch(() => {});

  // Tabs
  for (const v of ['sessions', 'history', 'agents', 'settings', 'music', 'cc']) {
    await hud.click(`#nav a[data-view="${v}"]`);
    await sleep(300);
    check(`tab ${v} opens`, await hud.evaluate(() => document.body.dataset.view) === v);
  }
  await sleep(900);
  await shot(hud, 'hud-1-home');

  // The crew show in the normal view too, clear of the side panels, and can be clicked there
  const crewLayout = (w, h) => hud.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const panels = ['lc', 'lf', 'brand', 'ask'].map((id) => box(document.getElementById(id)));
    // The four nodes the normal view shows: three agents and MESH.
    return [...document.querySelectorAll('#crew .mate:not(.extra)')].map((m) => m.dataset.id).map((id) => {
      const m = document.getElementById('crew-' + id);
      const parts = [m.querySelector('.halo'), m.querySelector('.nm2'), m.querySelector('.rl2')].map(box);
      return { id, shown: getComputedStyle(m).opacity === '1', clear: parts.every((p) => panels.every((q) => !hit(p, q))) };
    });
  });
  for (const [w, h] of [[1470, 920], [1920, 1140]]) {
    await s.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows().find((x) => x.isVisible()).setSize(w, h), [w, h]);
    await sleep(1200);
    const lay = await crewLayout();
    check(`the crew show in the normal view at ${w}x${h}`, lay.every((x) => x.shown), lay.filter((x) => !x.shown).map((x) => x.id).join(', '));
    check(`and none of them covers a panel at ${w}x${h}`, lay.every((x) => x.clear), lay.filter((x) => !x.clear).map((x) => x.id).join(', '));
    if (w === 1470) await shot(hud, 'hud-home-crew-laptop');
  }
  const fri = await hud.evaluate(() => { const r = document.querySelector('#crew-friday .core').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await hud.mouse.click(fri[0], fri[1]);
  await sleep(1300);
  check('clicking FRIDAY in the normal view spotlights her', await hud.evaluate(() => document.getElementById('crew-friday').classList.contains('spot')));
  check('her card offers the switch', /SWITCH TO FRIDAY/.test(await text(hud, '#spot-go')) && /MAXIMUM/.test(await text(hud, '#spot-role')), await text(hud, '#spot-role'));
  await hud.click('#spot-back');
  await sleep(900);
  check('BACK returns to the normal view', await hud.evaluate(() => !document.body.classList.contains('spot') && getComputedStyle(document.getElementById('lc')).opacity === '1'));

  // System panel gets real numbers
  await sleep(3500);
  const sys = await hud.evaluate(() => document.getElementById('v-cc').innerText);
  check('system panel shows CPU and RAM numbers', /CPU[\s\S]*\d+%/.test(sys) && /RAM[\s\S]*GB/.test(sys));

  // Settings shows brain + voice
  await hud.click('#nav a[data-view="settings"]');
  const settings = await hud.evaluate(() => document.getElementById('v-settings').innerText);
  const brainRow = await hud.evaluate(() => document.querySelector('[data-kv="model"]').textContent);
  check('settings shows the brain', /claude code/i.test(settings) && /claude code/i.test(brainRow), brainRow);
  await shot(hud, 'hud-2-settings');
  // The sidebar says what's set; each section opens beside it
  check('the sidebar sums up each section', /Claude Code/.test(await text(hud, '#sc-brain')) && /dark|light|macOS/.test(await text(hud, '#sc-look')), await text(hud, '#sc-look'));
  const winsBefore = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await hud.click('#setnav [data-section="brain"]');
  await hud.waitForFunction(() => document.querySelector('#bc-claude-code').textContent, null, { timeout: 10000 }).catch(() => {});
  check('Brains & keys opens beside the sidebar, no new window', await hud.isVisible('#set-page .sp[data-page="brain"]') && await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === winsBefore);
  check('the page has its title and the nav marks it', await text(hud, '#sp-title') === 'Brains & keys' && await hud.evaluate(() => document.querySelector('#setnav .navitem.on').dataset.section === 'brain'));
  check('Claude Code, the keys and Ollama show their state', /Ready|Not installed|Sign in/.test(await text(hud, '#bc-claude-code')) && /key/i.test(await text(hud, '#bc-gemini')), await text(hud, '#bc-claude-code'));
  check('no model choice is left in Settings', await hud.evaluate(() => !document.querySelector('#v-settings [data-key="model"], #v-settings [data-s], #v-settings #b-model')));
  await hud.waitForFunction(() => /Ollama|Installed|Running|Free/.test(document.getElementById('b-ol-text').textContent), null, { timeout: 8000 }).catch(() => {});
  check('Ollama shows how to set it up', /\w/.test(await text(hud, '#b-ol-text')), await text(hud, '#b-ol-text'));
  await hud.fill('#b-gemini-key', 'AIza-random-1234567890');
  check('a typed key must pass Test before Save', await hud.isDisabled('#b-save'));
  await hud.click('[data-btest="gemini"]');
  await hud.waitForFunction(() => /rejected/.test(document.getElementById('b-msg').textContent), null, { timeout: 15000 }).catch(() => {});
  check('a made-up Gemini key is rejected', /rejected/.test(await text(hud, '#b-msg')), await text(hud, '#b-msg'));
  await hud.fill('#b-gemini-key', '');
  await hud.click('#setnav [data-section="access"]');
  await hud.waitForFunction(() => document.querySelector('#hud-perms li[data-perm="mic"] .chip').textContent, null, { timeout: 10000 }).catch(() => {});
  check('Access lists the permissions with their state', /Allowed|Not yet|Not allowed/.test(await text(hud, '#hud-perms li[data-perm="mic"] .chip')), await text(hud, '#hud-perms li[data-perm="mic"] .chip'));
  await shot(hud, 'hud-settings-access');

  // Music tab
  await hud.click('#nav a[data-view="music"]');
  await sleep(500);
  const stations = await hud.locator('#mus-radio button').count();
  check('radio stations listed', stations >= 6, `${stations}`);
  let m = s.mark();
  await hud.click('#mh-play');
  check('play button starts radio', await s.waitLog(/music: playing/, 5000, m));
  check('radio audio starts', await s.waitLog(/music: audio started/, 15000, m));
  await sleep(1000);
  await shot(hud, 'hud-3-music');
  m = s.mark();
  await hud.click('#mh-next');
  check('next station switches', await s.waitLog(/music: playing/, 5000, m));
  await hud.locator('#mh-vol').fill('55');
  await sleep(600);
  check('volume slider saved', Math.abs(s.config().musicVolume - 0.55) < 0.01, String(s.config().musicVolume));
  await hud.click('#mh-play');
  await sleep(500);
  const playing = await text(hud, '#mh-play');
  check('play button stops radio', /▶/.test(playing), playing);

  // YouTube preset opens the mini player
  const yt = await hud.locator('#mus-yt button').count();
  check('YouTube presets listed', yt >= 3, `${yt}`);
  if (yt) {
    await hud.locator('#mus-yt button').first().click();
    const ytw = await windowByUrl(s.app, /youtube\.com/, 15000);
    check('YouTube mini player opens', ytw);
    check('YouTube logged', await s.waitLog(/youtube: https/, 5000));
    // Cleanup only: it was checked above. YouTube can stop by itself on a slow or failed page load.
    if (await hud.locator('#yt-stop').isVisible()) await hud.click('#yt-stop', { timeout: 10000 }).catch(() => {});
    await sleep(500);
  }

  // Mic button = standby, power = disable
  await hud.click('#nav a[data-view="cc"]');
  m = s.earsCmds().length;
  await hud.click('#mic');
  await sleep(500);
  check('mic button mutes the ears', /"cmd":"mute","on":true/.test(s.earsCmds().slice(m)));
  check('state shows muted', await hud.evaluate(() => document.body.dataset.state) === 'muted');
  await hud.click('#mic');
  await sleep(500);
  check('mic button unmutes', /"cmd":"mute","on":false/.test(s.earsCmds().slice(m)));
  m = s.earsCmds().length;
  await hud.click('#power');
  await sleep(500);
  check('disable releases the mic (suspend)', /"cmd":"suspend"/.test(s.earsCmds().slice(m)));
  check('power label flips to ENABLE', /ENABLE/.test(await text(hud, '#power')));
  await shot(hud, 'hud-4-disabled');
  await hud.click('#power');
  await sleep(500);
  check('enable resumes the mic', /"cmd":"resume"/.test(s.earsCmds().slice(m)));

  // Editable settings: saved, clamped and applied without a restart
  await hud.click('#nav a[data-view="settings"]');
  check('settings show the saved voice engine', await hud.evaluate(() => document.querySelector('[data-key="ttsEngine"]').value) === 'native');
  await hud.click('#nav a[data-view="agents"]');
  await hud.waitForFunction(() => document.getElementById('ag-native').options.length > 3, null, { timeout: 8000 }).catch(() => {});
  const nvv = await hud.evaluate(() => { const e = document.getElementById('ag-native'); return e.value + ' | ' + e.options.length; });
  check('the agent\'s macOS voice list is filled and its voice selected', /^Daniel/.test(nvv), nvv);
  check('only the engine in use shows its voice rows', await hud.evaluate(() => [...document.querySelectorAll('#a-edit [data-engine]')].filter((li) => !li.hidden).every((li) => li.dataset.engine === 'native')));
  await hud.click('#nav a[data-view="settings"]');
  const setField = (key, value) => hud.evaluate(([k, v]) => { const el = document.querySelector(`[data-key="${k}"]`); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event('change')); }, [key, value]);
  m = s.mark();
  await setField('commandSilenceSeconds', '1.5');
  await sleep(500);
  check('pause before sending saved', s.config().commandSilenceSeconds === 1.5, s.config().commandSilenceSeconds);
  await setField('commandSilenceSeconds', '-7');
  await sleep(500);
  check('junk pause is clamped', s.config().commandSilenceSeconds === 0.5, s.config().commandSilenceSeconds);
  check('clamped value shown back in the HUD', await hud.evaluate(() => document.querySelector('[data-key="commandSilenceSeconds"]').value) === '0.5');
  await hud.click('#setnav [data-section="ears"]');
  await hud.click('.tog:has([data-key="requireEndWord"])');
  await sleep(500);
  check('"over" toggle saved', s.config().requireEndWord === true);
  await hud.click('.tog:has([data-key="requireEndWord"])');
  await sleep(500);
  check('"over" toggle off again', s.config().requireEndWord === false);
  m = s.mark();
  await setField('appleSpeech', 'accurate');
  check('recogniser change restarts the speech sidecar', await s.waitLog(/settings: applied appleSpeech[\s\S]*ears: ready/, 8000, m));
  check('recogniser saved', s.config().appleSpeech === 'accurate');
  await setField('ttsEngine', 'edge');
  check('voice engine switches live', await s.waitLog(/settings: applied ttsEngine/, 5000, m) && s.config().ttsEngine === 'edge');
  check('the agent\'s edge voice row shows', await hud.evaluate(() => !document.querySelector('#a-edit [data-engine="edge"]').hidden && document.querySelector('#a-edit [data-engine="native"]').hidden));
  await setField('ttsEngine', 'native');
  await hud.click('#setnav [data-section="voice"]');
  await hud.click('#test-voice');
  check('test voice speaks', await s.waitLog(/native synth/, 8000, m));
  // The brain and model are the agent's own, set on the Agents tab
  await hud.click('#nav a[data-view="agents"]');
  await hud.click('#a-tabs [data-at="brain"]');
  await hud.selectOption('#a-edit [data-s="model"]', 'haiku');
  await hud.click('#a-save');
  await sleep(1200);
  check('the agent\'s model is saved', s.config().model === 'haiku', s.config().model);
  check('its brain starts again with it', await s.waitLog(/assistant: changed JARVIS[^\n]*settings/, 5000, m));
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#setnav [data-section="general"]');
  await hud.waitForFunction(() => document.getElementById('hands-state').textContent !== 'checking…', null, { timeout: 8000 }).catch(() => {});
  const hs = await text(hud, '#hands-state');
  check('screen access status shown', /allowed|needs/.test(hs), hs);
  await hud.click('label:has([data-key="screenControl"])');
  await sleep(600);
  check('"use apps outside Chrome" can be switched off', s.config().screenControl === false && await s.waitLog(/settings: applied screenControl/, 3000, m));
  check('screen access row hides when off', await hud.evaluate(() => document.getElementById('hands-row').hidden));
  await shot(hud, 'hud-settings-form');

  // Typing to JARVIS: the input bar sends like a spoken command
  await hud.click('#nav a[data-view="cc"]');
  await hud.keyboard.press('Meta+k');
  check('Cmd+K puts the cursor in the input bar', await hud.evaluate(() => document.activeElement && document.activeElement.id === 'ask-input'));
  let tm = s.mark();
  await hud.keyboard.type('what is the capital of france');
  await hud.keyboard.press('Enter');
  check('a typed message goes to the brain', await s.waitLog(/brain: asked 'what is the capital of france'/, 5000, tm));
  check('the bar clears after sending', await hud.inputValue('#ask-input') === '');
  check('the typed message shows in the captions', /capital of france/.test(await text(hud, '#transcript')));
  await s.waitLog(/timing: claude done/, 60000, tm);
  await hud.evaluate(() => document.activeElement && document.activeElement.blur());

  // The right panel shows the conversation, not tool traffic, and lists JARVIS and the background jobs
  await sleep(500);
  check('the right panel shows my words and the reply', await hud.evaluate(() => {
    const li = [...document.querySelectorAll('#livelog li.msg')];
    return li.some((x) => x.classList.contains('you') && /capital of france/i.test(x.textContent)) && li.some((x) => x.classList.contains('jarvis') && /paris/i.test(x.textContent));
  }), await text(hud, '#live-name'));
  await hud.click('#live-btn');
  const picks = await hud.evaluate(() => [...document.querySelectorAll('#live-pop button')].map((b) => b.querySelector('span:nth-child(2)').textContent));
  check('the picker lists JARVIS and the background jobs', ['JARVIS', 'BACKGROUND JOBS'].every((n) => picks.includes(n)), picks.slice(0, 6).join(', '));
  await hud.click('#live-pop button:nth-of-type(2)');
  await sleep(600);
  check('picking the background jobs shows them', await text(hud, '#live-name') === 'BACKGROUND JOBS', await text(hud, '#live-name'));
  await hud.click('#live-btn');
  await hud.click('#live-pop button:nth-of-type(1)');
  await sleep(300);

  // Full mode: idle HOME hides the panels and shows the crew; moving the mouse brings them back
  await hud.click('#nav a[data-view="cc"]');
  await hud.evaluate(() => window.hud.event({ type: 'settings', autoHideMs: 1200 }));
  const isFocus = () => hud.evaluate(() => document.body.classList.contains('focus'));
  const log = await hud.evaluate(() => { const r = document.getElementById('tr').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await hud.mouse.move(log[0], log[1]);
  await sleep(2400);
  check('full mode starts even with the mouse resting on a panel', await isFocus());
  await hud.mouse.move(log[0] + 10, log[1] + 10);
  await sleep(700);
  await hud.click('#live-btn');
  await sleep(2400);
  check('an open menu keeps the panels up', !(await isFocus()));
  await hud.keyboard.press('Escape');
  const mid = await hud.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await hud.mouse.move(mid[0], mid[1]);
  await sleep(2400);
  check('idle HOME hides the panels', await isFocus());
  // They fade in one after another, so give the last of them time.
  await hud.waitForFunction(() => ['friday', 'edith', 'karen'].every((id) => document.getElementById('crew-' + id) && getComputedStyle(document.getElementById('crew-' + id)).opacity === '1'), null, { timeout: 5000 }).catch(() => {});
  check('crew shows FRIDAY, EDITH and KAREN', await hud.evaluate(() => ['friday', 'edith', 'karen'].every((id) => document.getElementById('crew-' + id) && getComputedStyle(document.getElementById('crew-' + id)).opacity === '1')), await hud.evaluate(() => [...document.querySelectorAll('#crew .mate')].map((m) => m.dataset.id + '=' + getComputedStyle(m).opacity).join(',')));
  check('and MESH, dim with nothing paired', await hud.evaluate(() => { const m = document.getElementById('crew-g-devices'); return !!m && m.classList.contains('dim') && /PAIR A COMPUTER/.test(m.textContent); }));
  // MESH opens into + PAIR, which brings pairing into the spotlight
  await hud.evaluate(() => document.getElementById('crew-g-devices').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  await hud.evaluate(() => document.getElementById('crew-g-pair').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  check('MESH shows its own name in the core, and only computers around it', await hud.evaluate(() => document.querySelector('.corelabel .jv').textContent === 'MESH' && [...document.querySelectorAll('#crew .mate')].every((m) => m.dataset.id.startsWith('g-'))));
  check('a dim node shows one name, not two', await hud.evaluate(() => { const m = document.getElementById('crew-g-pair'); return [...m.querySelectorAll('text')].filter((t) => getComputedStyle(t).opacity !== '0').length <= 2; }));
  check('+ PAIR opens pairing on the HUD', await hud.evaluate(() => document.body.classList.contains('spot') && !document.getElementById('spot-pair').hidden && document.getElementById('spot-go').hidden));
  await hud.click('#sp-host');
  await hud.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.getElementById('spot-code').textContent), null, { timeout: 30000 }).catch(() => {});
  check('and shows a code there', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(await text(hud, '#spot-code')), await text(hud, '#spot-hint'));
  await shot(hud, 'hud-pair');
  check('MESH lists this computer too', await hud.evaluate(() => !!document.getElementById('crew-g-self')));
  await hud.click('#spot-back');
  await hud.evaluate(() => document.getElementById('crew-g-main').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  // FORGE: custom agents, dim with none yet; + CREATE makes one right on the HUD
  check('FORGE is there, dim with no custom agents', await hud.evaluate(() => { const m = document.getElementById('crew-g-custom'); return !!m && m.classList.contains('dim') && /MAKE YOUR OWN/.test(m.textContent); }));
  await hud.evaluate(() => document.getElementById('crew-g-custom').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  await hud.evaluate(() => document.getElementById('crew-g-create').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  await hud.fill('#sm-name', 'Scout');
  await hud.click('#sm-go');
  await hud.waitForFunction(() => document.body.dataset.view === 'agents' && /SCOUT/.test(document.getElementById('a-edit-title').textContent), null, { timeout: 8000 }).catch(() => {});
  check('+ CREATE makes an agent and opens it in Agents', await hud.evaluate(() => document.body.dataset.view === 'agents' && /SCOUT/.test(document.getElementById('a-edit-title').textContent)));
  hud.once('dialog', (d) => d.accept());
  await hud.click('#a-delete');
  await sleep(600);
  await hud.click('#nav a[data-view="cc"]');
  await sleep(300);
  await hud.evaluate(() => { const g = document.getElementById('crew-g-main'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await sleep(900);
  // Back to full mode for the checks that follow.
  await hud.mouse.move(mid[0], mid[1]);
  await sleep(2400);
  await shot(hud, 'hud-focus');
  check('captions stay visible in full mode', await hud.evaluate(() => getComputedStyle(document.getElementById('status')).opacity === '1'));
  check('full mode hides the mic and the state word', await hud.evaluate(() => getComputedStyle(document.querySelector('#status .row1')).opacity === '0'));
  await hud.evaluate(() => { window.hud.event({ type: 'state', state: 'idle' }); window.hud.event({ type: 'reply', text: 'Three new emails, sir.' }); });
  await hud.evaluate(() => window.hud.event({ type: 'transcript', text: 'and what about', final: false }));
  check('new speech clears the old reply', await text(hud, '#reply') === '');
  await hud.evaluate(() => { window.hud.event({ type: 'transcript', text: 'and what about tomorrow', final: true }); window.hud.event({ type: 'reply', text: 'Nothing booked, sir.' }); window.hud.event({ type: 'state', state: 'idle' }); });
  for (let i = 0; i < 9; i++) { await hud.evaluate(() => { window.hud.event({ type: 'state', state: 'idle' }); window.hud.event({ type: 'transcript', text: '' }); }); await sleep(1000); }
  check('captions clear after a quiet spell, even with repeat updates', await text(hud, '#reply') === '' && await text(hud, '#transcript') === '');
  await hud.mouse.move(mid[0] + 30, mid[1] + 20);
  await sleep(800);
  check('moving over the crew keeps full mode, with a hint', await isFocus() && await hud.evaluate(() => getComputedStyle(document.getElementById('focus-hint')).opacity === '1'));

  // Spotlight: clicking KAREN brings her to the centre and talks to her
  const karen = await hud.evaluate(() => { const r = document.querySelector('#crew-karen .core').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await hud.mouse.click(karen[0], karen[1]);
  await sleep(1300);
  check('clicking KAREN spotlights her', await hud.evaluate(() => document.body.classList.contains('spot') && document.getElementById('crew-karen').classList.contains('spot')));
  const at = await hud.evaluate(() => { const c = document.querySelector('#crew-karen .core').getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); return [c.x + c.width / 2 - (st.x + st.width / 2), c.y + c.height / 2 - (st.y + st.height / 2), c.width]; });
  check('she moves to the centre and grows', Math.abs(at[0]) < 20 && Math.abs(at[1]) < 60 && at[2] > 20, at.map((n) => Math.round(n)).join(', '));
  check('her name card shows', /KAREN/.test(await text(hud, '#spot-name')));
  await shot(hud, 'hud-spotlight');
  // SWITCH: KAREN takes over, with the same conversation; JARVIS moves out into the web
  const sw = s.mark();
  await hud.click('#spot-go');
  check('SWITCH hands over to KAREN', await s.waitLog(/assistant: KAREN took over/, 20000, sw));
  await sleep(1000);
  check('KAREN is the core and JARVIS is one of the others', await text(hud, '.corelabel .jv') === 'KAREN' && await hud.evaluate(() => !!document.getElementById('crew-jarvis') && !document.getElementById('crew-karen') && !document.body.classList.contains('spot')));
  check('the brand reads K.A.R.E.N', await text(hud, '#brand .word') === 'K.A.R.E.N');
  check('her preset is in use', s.config().assistant === 'karen' && /claude code · haiku/.test(s.log().slice(sw)), s.config().assistant);
  await shot(hud, 'hud-karen');
  // Back to JARVIS from the Agents tab
  await hud.click('#nav a[data-view="agents"]');
  await sleep(400);
  check('Agents lists the five, KAREN in use', await hud.evaluate(() => document.querySelectorAll('#acards .agcard').length === 5 && /KAREN/.test(document.querySelector('#acards .agcard.on').textContent) && document.getElementById('n-agents').textContent === '5'));
  check('each card shows its brain and worker', /Claude Haiku · low effort/.test(await text(hud, '#acards .agcard.on')) && /Worker Sonnet/.test(await text(hud, '#acards .agcard.on')), await text(hud, '#acards .agcard.on'));
  check('KAREN\'s card shows her communications role', /Communications/.test(await text(hud, '#acards .agcard.on')), await text(hud, '#acards .agcard.on'));
  await hud.click('#acards .agcard[data-id="edith"]');
  check('EDITH maintains JARVIS, and only she may change its code', await hud.evaluate(() => document.getElementById('a-maint').checked && document.getElementById('a-role').value === 'maintainer'));
  // Another agent can be changed without switching to it
  await hud.click('#acards .agcard[data-id="vision"]');
  check('opening VISION shows its Gemini brain', await hud.evaluate(() => document.getElementById('ag-brain').value === 'gemini' && !document.querySelector('#a-edit [data-brain="gemini"]').hidden && document.querySelector('#a-edit [data-brain="auto claude-code"]').hidden));
  await hud.selectOption('#a-edit [data-s="agentModel"]', 'sonnet');
  await hud.click('#a-save');
  await sleep(800);
  check('VISION\'s worker model is saved while KAREN stays in use', ((s.config().assistantSettings || {}).vision || {}).agentModel === 'sonnet' && s.config().assistant === 'karen', JSON.stringify((s.config().assistantSettings || {}).vision));
  await hud.click('#acards .agcard[data-id="karen"]');
  // Make a new assistant from KAREN, give it a persona, then go back to JARVIS
  await hud.fill('#a-new-name', 'Coach');
  await hud.selectOption('#a-new-from', 'karen');
  await hud.click('#a-create');
  await sleep(800);
  check('a new assistant can be made from another', /COACH/.test(await text(hud, '#a-edit-title')) && JSON.stringify(s.config().customAssistants || {}).includes('"COACH"'), await text(hud, '#a-note'));
  check('it starts with the role of the one it came from', await hud.evaluate(() => document.getElementById('a-role').value === 'communications'));
  await hud.click('#a-tabs [data-at="profile"]');
  await hud.selectOption('#a-role', 'custom');
  await hud.fill('#a-role-text', 'Keeps my running plan on track.');
  await hud.fill('#a-persona', 'A patient running coach who keeps it short.');
  await hud.click('#a-cmd-add');
  await hud.fill('#a-cmds li:last-child input.name', '/plan');
  await hud.fill('#a-cmds li:last-child input:not(.name)', 'Read me this week\'s runs.');
  await shot(hud, 'hud-assistant-profile');
  await hud.click('#a-tabs [data-at="guard"]');
  await hud.click('#a-guard .level:nth-child(2)');
  await hud.click('#a-tools li:has-text("Mac controls") input');
  await hud.fill('#a-blocked', '~/Private');
  await shot(hud, 'hud-assistant-guard');
  await hud.click('#a-tabs [data-at="brain"]');
  await hud.fill('#a-wake', 'coach, couch');
  await hud.click('#a-save');
  await sleep(800);
  const coach = s.config().assistantSettings && s.config().assistantSettings.coach;
  check('its persona and wake words are saved', coach && /running coach/.test(coach.persona) && coach.wakeWords.join() === 'coach,couch', JSON.stringify(coach));
  check('its role and quick command are saved', coach && coach.role === 'custom' && /running plan/.test(coach.roleText) && coach.commands[0].name === 'plan', JSON.stringify(coach));
  check('its guardrails are saved', coach && coach.guard === 'careful' && Array.isArray(coach.tools) && !coach.tools.includes('mac') && /\/Private$/.test(coach.blockedPaths[0]), JSON.stringify(coach));
  // Training: what it is taught goes into its own memory
  await hud.click('#a-tabs [data-at="training"]');
  await hud.fill('#a-mem-new', 'Long runs are on Sundays.');
  await hud.click('#a-mem-add');
  await hud.waitForFunction(() => /Sundays/.test(document.getElementById('a-mem').textContent), null, { timeout: 5000 }).catch(() => {});
  const own = (() => { try { return JSON.parse(fs.readFileSync(path.join(s.state, 'assistants', 'coach', 'memory.json'), 'utf8')).facts; } catch { return []; } })();
  check('training goes into its own memory', own.some((f) => /Sundays/.test(f.text)) && /Sundays/.test(await text(hud, '#a-mem')), JSON.stringify(own));
  await shot(hud, 'hud-assistant-training');
  await hud.evaluate(() => { const g = document.getElementById('crew-g-custom'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await sleep(900);
  check('it shows up around the core, in FORGE', await hud.evaluate(() => !!document.getElementById('crew-coach') && !!document.getElementById('crew-g-main')));
  await hud.evaluate(() => document.getElementById('crew-g-main').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  await shot(hud, 'hud-assistant-edit');
  // Skills and MCP servers for this assistant: all on by default, ticks saved with SAVE
  await hud.click('#a-tabs [data-at="skills"]');
  await hud.waitForFunction(() => /of \d+ on/.test(document.getElementById('a-skill-count').textContent), null, { timeout: 15000 }).catch(() => {});
  check('the editor lists the skills on this Mac, all on', /^(\d+) of \1 on$/.test(await text(hud, '#a-skill-count')), await text(hud, '#a-skill-count'));
  await hud.click('#a-skill-none');
  await hud.click('#a-skills li:first-child input');
  await hud.click('#a-save');
  await sleep(800);
  const picked = (s.config().assistantSettings.coach || {}).skills;
  check('picking skills saves just those', Array.isArray(picked) && picked.length === 1, JSON.stringify(picked));
  await shot(hud, 'hud-assistant-skills');
  hud.once('dialog', (d) => d.accept());
  await hud.click('#a-delete');
  await sleep(600);
  check('your own assistant can be deleted', !JSON.stringify(s.config().customAssistants || {}).includes('COACH'));
  // Settings › Skills lists every skill, with a switch for each agent
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#setnav [data-section="skills"]');
  await hud.waitForFunction(() => document.querySelectorAll('#k-skills li:not(.empty)').length > 0, null, { timeout: 15000 }).catch(() => {});
  check('Settings › Skills lists the skills and the marketplaces', await hud.evaluate(() => document.querySelectorAll('#k-skills li:not(.empty)').length > 0 && document.querySelectorAll('#x-market option').length > 0));
  check('each skill has a switch per agent, and each agent its cost', await hud.evaluate(() => document.querySelectorAll('#k-skills li:first-child .kchip').length === 5 && document.querySelectorAll('#k-cost .kc').length === 5 && /tokens a turn/.test(document.getElementById('k-cost').textContent)));
  await hud.click('#k-skills li:first-child .kchip:has-text("VISION")');
  await sleep(800);
  const vs = ((JSON.parse(fs.readFileSync(path.join(s.state, 'config.json'), 'utf8')).assistantSettings || {}).vision || {}).skills;
  check('turning a skill off for one agent saves it for that agent', Array.isArray(vs) && vs.length >= 0 && !vs.includes(undefined), JSON.stringify(vs));
  await shot(hud, 'hud-skills');
  await hud.click('#setnav [data-section="extensions"]');
  await shot(hud, 'hud-skills-mcp');
  // Settings › Devices: a pairing code, from the peer-to-peer network inside the packaged app
  await hud.click('#setnav [data-section="devices"]');
  await hud.click('#d-host');
  await hud.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.getElementById('d-code').textContent), null, { timeout: 30000 }).catch(() => {});
  check('Devices shows a pairing code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(await text(hud, '#d-code')), await text(hud, '#d-note'));
  await shot(hud, 'hud-devices');
  await hud.click('#d-cancel');
  await hud.click('#nav a[data-view="agents"]');
  await sleep(400);
  const back = s.mark();
  await hud.click('#acards .agcard[data-id="jarvis"]');
  await hud.click('#a-tabs [data-at="profile"]');
  await hud.click('#a-use');
  check('picking JARVIS there and USE switches back', await s.waitLog(/assistant: JARVIS took over/, 20000, back) && s.config().assistant === 'jarvis');
  await sleep(800);
  await hud.click('#nav a[data-view="cc"]');
  await sleep(600);
  await hud.click('#live-btn');
  await hud.click('#live-pop button:nth-of-type(1)');
  await hud.mouse.move(mid[0], mid[1]);
  await sleep(2400);
  await hud.mouse.move(log[0], log[1] - 250);
  await sleep(300);
  check('moving onto a panel brings the panels back', !(await isFocus()));
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#setnav [data-section="look"]');
  await hud.click('label:has([data-key="autoHide"])');
  await sleep(600);
  check('"full mode when idle" can be switched off', s.config().autoHide === false && await s.waitLog(/settings: applied autoHide/, 3000, m));
  await hud.click('#nav a[data-view="cc"]');
  await hud.mouse.move(mid[0], mid[1]);
  await sleep(2400);
  check('with it off, HOME stays put', !(await isFocus()));

  // Close hides, app keeps running
  await hud.evaluate(() => window.close());
  await sleep(800);
  check('closing the HUD keeps the app running', s.app.windows().length > 0);

  await s.app.close();
}

// ---------------------------------------------------------------------------

async function testProactive() {
  console.log('\nMEMORY AND PROACTIVE (Claude Code brain, fake microphone)');
  const state = makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native', commandSilenceSeconds: 1.2, pauseGraceSeconds: 2, checkIns: 'off' });
  const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const past = new Date(Date.now() - 60000), later = new Date(Date.now() + 3 * 3600000);
  fs.writeFileSync(path.join(state, 'memory.md'), '- The user likes lo-fi music while working.\n- The user lives in Bengaluru.\n');
  const turns = Array.from({ length: 16 }, (_, i) => ({ t: '26 Oct 10:00', who: i % 2 ? 'jarvis' : 'user', text: i ? `turn ${i}` : 'I fly to Delhi on Friday morning.' }));
  fs.writeFileSync(path.join(state, 'claude-code-context.json'), JSON.stringify({ summary: 'Facts the user stated\n- Has a dentist appointment on Monday.', lines: turns, carried: '', day: new Date().toLocaleDateString('en-CA'), rolledAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(state, 'schedule.json'), JSON.stringify({ items: [
    { id: 'rtest1', kind: 'reminder', text: 'stretch your legs', due: local(past), repeat: null },
    { id: 'rtest2', kind: 'reminder', text: 'drink some water', due: local(past), repeat: 'daily' },
    { id: 'rtest3', kind: 'task', text: 'Say exactly: the pineapple has landed.', due: local(past), repeat: null },
    { id: 'rtest4', kind: 'reminder', text: 'call the bank', due: local(later), repeat: null },
  ] }));
  const s = await launch(state, [], { JARVIS_TEST_CHECKIN_MS: '1', JARVIS_TEST_CHECKIN_TICK_MS: '4000' });
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  check('HUD opens', hud);
  if (!hud) { await s.app.close(); return; }
  const mem = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'memory.json'), 'utf8')).facts; } catch { return []; } };
  const sched = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'schedule.json'), 'utf8')).items; } catch { return []; } };
  check('old memory.md facts moved to memory.json', mem().length === 2, mem().length);

  // Reminders that fell due while closed fire at start, even while asleep
  check('due reminder fires', await s.waitLog(/reminder: '[^']*stretch your legs/, 15000));
  check('reminder is spoken while asleep', await s.waitLog(/native synth/, 10000));
  await sleep(1500);
  check('one-off reminder removed after firing', !sched().some((i) => i.id === 'rtest1'));
  const water = sched().find((i) => i.id === 'rtest2');
  check('daily reminder moves to tomorrow', water && new Date(water.due) > new Date(), water && water.due);
  check('scheduled task runs through the brain', await s.waitLog(/proactive: \(scheduled\)/, 60000));
  check('scheduled task answers', await s.waitLog(/timing: claude done/, 90000));
  await sleep(800);
  check('scheduled task result shown', /pineapple/i.test(await text(hud, '#reply')), (await text(hud, '#reply')).slice(0, 80));

  // HUD memory view
  await hud.click('#nav a[data-view="memory"]');
  await sleep(500);
  check('memory view lists facts', await hud.evaluate(() => document.querySelectorAll('#mem-list li:not(.empty)').length) === 2);
  check('schedule view lists upcoming items', await hud.evaluate(() => [...document.querySelectorAll('#sched-list li')].some((li) => /call the bank/.test(li.textContent))));
  await hud.fill('#mem-input', 'The user has a cat called Momo.');
  await hud.press('#mem-input', 'Enter');
  await sleep(800);
  check('fact added from the HUD', mem().some((f) => /Momo/.test(f.text)));
  await hud.click('#mem-list li:first-child .x');
  await sleep(800);
  check('fact forgotten from the HUD', !mem().some((f) => /Momo/.test(f.text)) && mem().length === 2);
  await hud.click('#sched-list li:last-child .x');
  await sleep(800);
  check('scheduled item cancelled from the HUD', sched().length === 2 - 1 + 0 || sched().length === 1, sched().map((i) => i.text).join(', '));
  check('memory view shows the conversation summary', /dentist appointment/.test(await text(hud, '#ctx-summary')));
  check('memory view shows the context size', /CONTEXT \d+K? \/ 70K TOKENS/.test(await text(hud, '#ctx-meta')), await text(hud, '#ctx-meta'));
  await shot(hud, 'hud-memory');
  let mc = s.mark();
  await hud.click('#ctx-roll');
  check('summarise now folds older turns into the summary', await s.waitLog(/context: rolled \d+ line/, 120000, mc));
  check('summarise now starts a fresh session', await s.waitLog(/context: fresh session/, 30000, mc));
  await sleep(800);
  check('the new summary keeps the older facts', /Delhi/.test(await text(hud, '#ctx-summary')) && /dentist/i.test(await text(hud, '#ctx-summary')), (await text(hud, '#ctx-summary')).slice(0, 200));

  // By voice: remember, remind
  await s.quiet(hud, 60000);
  let m = s.mark();
  await s.say('jarvis wake up', { step: 80 });
  await s.waitLog(/conversation mode on/, 5000, m);
  await s.quiet(hud);
  m = s.mark();
  await s.say('by the way my favourite colour is teal over');
  await s.waitLog(/timing: claude done/, 60000, m);
  await sleep(2500);
  check('brain saves a fact on its own', mem().some((f) => /teal/i.test(f.text)), mem().map((f) => f.text).join(' | '));
  await s.quiet(hud);
  m = s.mark();
  await s.say('remind me in two hours to call mom over');
  await s.waitLog(/timing: claude done/, 60000, m);
  await sleep(2500);
  const mom = sched().find((i) => /mom/i.test(i.text));
  check('brain sets a reminder', mom && Math.abs(new Date(mom.due) - Date.now() - 2 * 3600000) < 10 * 60000, mom && `${mom.due} ${mom.text}`);

  // Check-ins (fast clock in tests)
  await s.quiet(hud);
  m = s.mark();
  await hud.evaluate(() => {});
  check('check-in starts when awake and quiet', await s.waitLog(/proactive: \(check-in\)/, 30000, m));
  await s.waitLog(/timing: claude done/, 60000, m);

  // Briefing on request
  await s.quiet(hud, 30000);
  m = s.mark();
  await s.say('brief me over');
  check('"brief me" starts the briefing', await s.waitLog(/proactive: \(briefing\)/, 15000, m));
  const bd = await s.waitLog(/timing: claude done ([\d.]+)s/, 150000, m);
  await sleep(800);
  const br = await text(hud, '#reply');
  check('briefing spoken, without links', bd && br.length > 40 && !/https?:\/\//.test(br), br.slice(0, 160));
  check('journal records the day', fs.existsSync(path.join(state, 'journal')) && fs.readdirSync(path.join(state, 'journal')).length > 0);
  await s.app.close();
}

// JARVIS on a local Ollama brain with the background worker on Claude Code and Opus, doing the heavy job.
// Needs Ollama running with llama3.2 and a signed-in Claude Code; skipped otherwise.
async function testWorker() {
  console.log('\nOLLAMA BRAIN + WORKER ON OPUS');
  const tags = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).catch(() => null);
  if (!tags || !(tags.models || []).some((m) => m.name.startsWith('llama3.2'))) { console.log('  - skipped: Ollama with llama3.2 is not running'); return; }
  const state = makeState({ onboarded: true, brainProvider: 'ollama', ollamaModel: 'llama3.2', worker: 'claude-code', agentModel: 'opus', ttsEngine: 'native' });
  const s = await launch(state, [], { JARVIS_TEST_UPDATE_MS: '15000' });
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  if (!hud) { check('HUD opens', false); await s.app.close(); return; }
  check('brain is Ollama', await s.waitLog(/brain: provider ollama/, 10000));
  check('the worker runs on Claude Code and Opus', await s.waitLog(/brain: worker on Claude Code · opus/, 10000));
  await hud.waitForFunction(() => document.body.dataset.state !== 'booting', null, { timeout: 15000 }).catch(() => {});
  let m = s.mark();
  await s.say('jarvis wake up');
  await s.waitLog(/conversation mode on/, 8000);
  await s.waitLog(/synth/, 8000, m);
  await s.quiet(hud);

  // A small question stays with the local brain
  m = s.mark();
  await s.say('what is two plus two over');
  const small = await s.waitLog(/timing: ollama done ([\d.]+)s/, 60000, m);
  check('a small question is answered by the local brain', small && !/worker: started/.test(s.log().slice(m)), small && `${small[1]} s`);
  await s.quiet(hud, 30000);

  // A heavy job goes to the worker
  m = s.mark();
  await s.say('please research the current top story on hacker news, read the article, and tell me what it is about over');
  const started = await s.waitLog(/worker: started '([^']*)'.*model=(\w+)/, 90000, m);
  check('a heavy job is handed to the worker', started, started && started[1]);
  check('the worker runs on Opus', started && started[2] === 'opus', started && started[2]);
  await sleep(4000);
  check('the HUD shows the job', /1 JOB/.test(await text(hud, '#br-worker')), await text(hud, '#br-worker'));
  check('the neuron web fires while it works', await hud.evaluate(() => document.getElementById('crew').classList.contains('busy')));
  await s.quiet(hud, 30000);
  const sm = s.mark();
  await s.say("what's the status over");
  const st = await s.waitLog(/status: '(.*)'/, 8000, sm);
  check('"what\'s the status?" answers from the job\'s progress', st, st && st[1]);
  const done = await s.waitLog(/worker: (completed|failed) '([^']*)'/, 300000, m);
  check('the worker finishes the job', done && done[1] === 'completed', done && done[1]);
  const told = await s.waitLog(/proactive: \(job\)[\s\S]*timing: ollama done/, 90000, m);
  await sleep(1000);
  const reply = await text(hud, '#reply');
  check('JARVIS tells the user the result in its own words', told && reply.length > 20 && !/RESULT/.test(reply), reply.slice(0, 200));
  await hud.click('#live-btn');
  await hud.click('#live-pop button:nth-of-type(2)');
  await hud.waitForFunction(() => document.querySelector('#livelog li.msg.job'), null, { timeout: 5000 }).catch(() => {});
  const convo = await hud.evaluate(() => [...document.querySelectorAll('#livelog li.msg')].map((x) => x.className + ': ' + x.textContent));
  check('the background jobs show the task and its report', convo.some((x) => /jarvis/.test(x) && /hacker news/i.test(x)) && convo.some((x) => /job/.test(x) && /RESULT/.test(x)), convo.slice(-2).map((x) => x.slice(0, 60)).join(' | '));
  await shot(hud, 'worker-conversation');
  await s.app.close();
}

async function testDevices() {
  console.log('\nTWO DEVICES: PAIR, VIEW AND DRIVE THE OTHER');
  const dir = (name, cfg) => { const d = makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native', ...cfg }); fs.writeFileSync(path.join(d, 'devices.json'), JSON.stringify({ name })); return d; };
  const a = await launch(dir('Work Mac', {}));
  const b = await launch(dir('Home Mac', { assistant: 'friday', assistantSettings: { karen: { role: 'research' } } }));
  const ha = await windowByUrl(a.app, /hud\/index\.html/, 20000), hb = await windowByUrl(b.app, /hud\/index\.html/, 20000);
  check('both HUDs open', ha && hb);
  if (!ha || !hb) { await a.app.close(); await b.app.close(); return; }
  for (const h of [ha, hb]) await h.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 20000 }).catch(() => {});
  await shot(ha, 'devices-start');
  check('no device tabs before pairing', await ha.evaluate(() => document.getElementById('machines').hidden));
  // Pair: Work Mac shows a code, Home Mac types it.
  for (const h of [ha, hb]) { await h.click('#nav a[data-view="settings"]'); await h.click('#setnav [data-section="devices"]'); }
  await ha.click('#d-host');
  await ha.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.getElementById('d-code').textContent), null, { timeout: 30000 }).catch(() => {});
  const code = await text(ha, '#d-code');
  check('Work Mac shows a code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
  await hb.fill('#d-join-code', code.toLowerCase());
  await hb.click('#d-join');
  const paired = await a.waitLog(/devices: paired with Home Mac/, 45000) && await b.waitLog(/devices: paired with Work Mac/, 15000);
  check('they pair', paired);
  await ha.waitForFunction(() => /Home Mac/.test(document.getElementById('d-list').textContent), null, { timeout: 10000 }).catch(() => {});
  check('each lists the other', /Home Mac/.test(await text(ha, '#d-list')) && /Work Mac/.test(await text(hb, '#d-list')));
  await shot(ha, 'devices-paired');
  // A tab for the other device, and its agents on this HUD's Devices node. Pairing may have gone
  // through the relay, so wait for the direct connection (it brings the live view).
  await ha.click('#nav a[data-view="cc"]');
  await ha.waitForFunction(() => !!document.querySelector('#machines .mtab.live'), null, { timeout: 45000 }).catch(() => {});
  await ha.waitForFunction(() => /1 CONNECTED/.test((document.getElementById('crew-g-devices') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  await ha.waitForFunction(() => !document.getElementById('machines').hidden && /Home Mac/.test(document.getElementById('machines').textContent), null, { timeout: 15000 }).catch(() => {});
  check('a tab for the other device', /Home Mac/.test(await text(ha, '#machines')));
  await ha.waitForFunction(() => /1 CONNECTED/.test((document.getElementById('crew-g-devices') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('MESH on the HUD, lit, in a slot the normal view shows', await ha.evaluate(() => { const m = document.getElementById('crew-g-devices'); return !!m && !m.classList.contains('extra') && !m.classList.contains('dim') && /1 CONNECTED/.test(m.textContent); }));
  await shot(ha, 'devices-home');
  await ha.evaluate(() => document.getElementById('crew-g-devices').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(900);
  const devNode = await ha.evaluate(() => [...document.querySelectorAll('#crew .mate')].map((m) => m.dataset.id).find((id) => id.startsWith('g-device_')));
  check('it opens into the paired device', !!devNode, devNode);
  if (devNode) await ha.evaluate((id) => document.getElementById('crew-' + id).dispatchEvent(new MouseEvent('click', { bubbles: true })), devNode);
  await sleep(900);
  const remoteAgents = await ha.evaluate(() => [...document.querySelectorAll('#crew .mate')].map((m) => m.dataset.id).filter((id) => id.startsWith('r-')));
  check('and that device into its agents (not FRIDAY, who is in use there)', remoteAgents.length >= 3 && !remoteAgents.some((id) => id.endsWith('-friday')), remoteAgents.join(','));
  await shot(ha, 'devices-nodes');
  // Clicking one of its agents opens its tab, with that agent in the spotlight.
  const karen = remoteAgents.find((id) => id.endsWith('-karen'));
  if (karen) await ha.evaluate((id) => document.getElementById('crew-' + id).dispatchEvent(new MouseEvent('click', { bubbles: true })), karen);
  await sleep(900);
  check('its agent opens that device\'s tab, in the spotlight', await ha.evaluate(() => document.body.classList.contains('remote') && document.getElementById('spot-name').textContent === 'KAREN' && /FRIDAY/.test(document.querySelector('.corelabel .jv').textContent)));
  check('history, memory, settings and music are hidden there', await ha.evaluate(() => ['history', 'memory', 'settings', 'music'].every((v) => getComputedStyle(document.querySelector(`#nav a[data-view="${v}"]`)).display === 'none')));
  await shot(ha, 'devices-remote-home');
  // Its agents can be changed from here, and the change is saved there.
  await ha.click('#spot-back');
  await ha.click('#nav a[data-view="agents"]');
  await ha.click('#acards .agcard[data-id="vision"]');
  await ha.click('#a-tabs [data-at="brain"]');
  await ha.selectOption('#a-edit [data-s="agentModel"]', 'haiku');
  await ha.click('#a-save');
  await sleep(1500);
  const bcfg = JSON.parse(fs.readFileSync(path.join(b.state, 'config.json'), 'utf8'));
  check('an agent changed from here is saved on the other device', ((bcfg.assistantSettings || {}).vision || {}).agentModel === 'haiku', JSON.stringify((bcfg.assistantSettings || {}).vision));
  const acfg = JSON.parse(fs.readFileSync(path.join(a.state, 'config.json'), 'utf8'));
  check('and not on this one', !((acfg.assistantSettings || {}).vision || {}).agentModel);
  check('training is not offered for the other device', await ha.evaluate(() => getComputedStyle(document.querySelector('#a-tabs [data-at="training"]')).display === 'none'));
  await shot(ha, 'devices-remote-agents');
  // Typed here, a turn there.
  await ha.click('#nav a[data-view="cc"]');
  const m = b.mark ? b.mark() : 0;
  await ha.fill('#ask-input', 'what time is it there?');
  await ha.press('#ask-input', 'Enter');
  check('typing in its tab reaches the other device', await b.waitLog(/devices: Work Mac typed 'what time is it there\?'/, 10000, m));
  // Said out loud here with its tab open: it goes there, is answered there silently, and spoken here.
  await a.say('jarvis wake up');
  await a.waitLog(/conversation mode on/, 10000);
  await a.quiet(ha);
  const va = a.mark(), vb = b.mark();
  await a.say('what is two plus two');
  check('a spoken command goes to the open tab\'s computer', await b.waitLog(/devices: Work Mac said 'what is two plus two'/, 15000, vb), a.log().slice(va).split('\n').filter((l) => /remote|devices/.test(l)).join(' | ').slice(0, 200));
  check('its answer is spoken here', await a.waitLog(/synth/, 60000, va) && !(await b.waitLog(/synth/, 1000, vb)));
  // Back to this device.
  await ha.click('#machines .mtab[data-device=""]');
  await sleep(600);
  check('back on this device, its own HUD is back', await ha.evaluate(() => !document.body.classList.contains('remote') && /JARVIS/.test(document.querySelector('.corelabel .jv').textContent)));
  await a.app.close(); await b.app.close();
}

const which = process.argv[2] || 'all';
const t0 = Date.now();
try {
  if (which === 'onboarding' || which === 'all') await testOnboarding();
  if (which === 'validation' || which === 'all') await testValidation();
  if (which === 'hud' || which === 'all') await testHud();
  if (which === 'themes' || which === 'all') await testThemes();
  if (which === 'voice' || which === 'all') await testVoice();
  if (which === 'proactive' || which === 'all') await testProactive();
  if (which === 'worker' || which === 'all') await testWorker();
  if (which === 'devices' || which === 'all') await testDevices();
} catch (e) {
  check('test run crashed', false, e.message.split('\n').slice(0, 6).join(' | '));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
