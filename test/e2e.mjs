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
    config: () => JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')),
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
  check('blank Anthropic model falls back to default', /^claude-/.test(c.anthropicModel), c.anthropicModel);

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
    await hud.click('.setcard[data-section="ears"]');
    await sleep(800);
    check('Settings opens Listening inside the box', await hud.isVisible('#set-page .sp[data-page="ears"]'));
    await hud.click('#sp-back');
    await hud.click('.setcard[data-section="voice"]');
    const v = await hud.inputValue('[data-key="kokoroSpeed"]').catch(() => '');
    check('Settings shows the clamped speed', Number(v) <= 2, v);
    const before = s.config().elevenLabsApiKey;
    await hud.click('#sp-back');
    await hud.click('.setcard[data-section="extras"]');
    await hud.click('#x-save');
    await hud.waitForFunction(() => /Saved/.test(document.getElementById('x-msg').textContent), null, { timeout: 8000 }).catch(() => {});
    check('saving with empty key fields keeps the stored keys', s.config().elevenLabsApiKey === before && String(before).startsWith('enc:'));
    await hud.click('#sp-back');
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
  for (const page of ['brain', 'access', 'voice']) {
    await hud.click(`.setcard[data-section="${page}"]`);
    await sleep(1200);
    await shot(hud, `settings-${page}-minimal-light`);
    await hud.click('#sp-back');
  }
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
  check('brain starts a background agent', await s.waitLog(/brain: (friday|karen|edith|vision) started/, 60000, m));
  check('brain answers before the agent finishes', await s.waitLog(/timing: claude done/, 60000, m) && !s.log().slice(m).match(/brain: \w+ completed/));
  check('agent completes', await s.waitLog(/brain: (friday|karen|edith|vision) completed/, 120000, m));
  const bg = await s.waitLog(/brain: background turn '(.*)/, 60000, m);
  const spokenAt = s.log().indexOf('brain: background turn', m);
  check('agent result is spoken', bg && /20\d\d|year/i.test(bg[1]) && await s.waitLog(/native synth/, 10000, spokenAt), bg && bg[1]);
  const footer = await text(hud, '#br-worker');
  check('HUD footer shows no jobs again', /NO JOBS RUNNING/.test(footer), footer);

  // Longer job: quick spoken reply without technical words, live progress, "what's the status?" answered locally
  await s.quiet(hud);
  m = s.mark();
  await s.say('in the background, run the shell command ping -c 20 localhost three separate times one after another, then tell me the word finished over');
  check('long job starts', await s.waitLog(/brain: (friday|karen|edith|vision) started/, 60000, m));
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
  check('long job completes', await s.waitLog(/brain: (friday|karen|edith|vision) completed/, 180000, m));

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
  for (const v of ['sessions', 'history', 'settings', 'music', 'cc']) {
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
    return ['friday', 'karen', 'edith', 'vision'].map((id) => {
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
  let nm = s.mark();
  await hud.mouse.click(fri[0], fri[1]);
  await sleep(1300);
  check('clicking FRIDAY in the normal view spotlights her', await hud.evaluate(() => document.getElementById('crew-friday').classList.contains('spot')) && await s.waitLog(/talking to friday \(HUD\)/, 3000, nm));
  await hud.click('#spot-back');
  await sleep(900);
  check('BACK TO JARVIS returns to the normal view', await hud.evaluate(() => !document.body.classList.contains('spot') && getComputedStyle(document.getElementById('lc')).opacity === '1'));

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
  // The big choices: cards show what's set; each opens its page inside the Settings box
  check('settings cards show the brain and worker', /CLAUDE CODE.*AGENTS/.test(await text(hud, '#sc-brain')), await text(hud, '#sc-brain'));
  const winsBefore = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await hud.click('.setcard[data-section="brain"]');
  await hud.waitForFunction(() => document.querySelector('#bc-claude-code').textContent, null, { timeout: 10000 }).catch(() => {});
  check('Brain & worker opens inside the Settings box, no new window', await hud.isVisible('#set-page .sp[data-page="brain"]') && await hud.isHidden('#setcards') && await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === winsBefore);
  check('the page has a Back button and a title', await hud.isVisible('#sp-back') && await text(hud, '#sp-title') === 'BRAIN & WORKER');
  check('all four brains are offered, with their state', await hud.locator('.bcard').count() === 4 && /READY|NOT INSTALLED|SIGN IN/.test(await text(hud, '#bc-claude-code')), await text(hud, '#bc-claude-code'));
  await hud.click('.bcard[data-b="ollama"]');
  await hud.waitForFunction(() => /Ollama/.test(document.getElementById('b-ol-text').textContent), null, { timeout: 8000 }).catch(() => {});
  check('choosing Ollama shows its guided panel', await hud.isVisible('.bpanel[data-for="ollama"]') && /Ollama/.test(await text(hud, '#b-ol-text')), await text(hud, '#b-ol-text'));
  if (!(await hud.isDisabled('#b-save'))) {
    await hud.click('#b-save');
    await hud.waitForFunction(() => /Saved/.test(document.getElementById('b-msg').textContent), null, { timeout: 8000 }).catch(() => {});
    check('switching the brain is saved and offers a restart', s.config().brainProvider === 'ollama' && await hud.isVisible('#b-restart'), await text(hud, '#b-msg'));
    await hud.click('.bcard[data-b="claude-code"]');
    await hud.click('#b-save');
    await sleep(800);
  } else check('Save waits until Ollama is ready', /Ollama|model/.test(await text(hud, '#b-msg')), await text(hud, '#b-msg'));
  await hud.click('.bcard[data-b="gemini"]');
  await hud.fill('#b-gemini-key', 'AIza-random-1234567890');
  check('a typed key must pass TEST before Save', await hud.isDisabled('#b-save'));
  await hud.click('[data-btest="gemini"]');
  await hud.waitForFunction(() => /rejected/.test(document.getElementById('b-msg').textContent), null, { timeout: 15000 }).catch(() => {});
  check('a made-up Gemini key is rejected', /rejected/.test(await text(hud, '#b-msg')), await text(hud, '#b-msg'));
  await hud.fill('#b-gemini-key', '');
  await hud.click('#sp-back');
  check('Back returns to the cards', await hud.isVisible('#setcards') && await hud.isHidden('#set-page'));
  await hud.click('.setcard[data-section="access"]');
  await hud.waitForFunction(() => document.querySelector('#hud-perms li[data-perm="mic"] .chip').textContent, null, { timeout: 10000 }).catch(() => {});
  check('Access lists the permissions with their state', /ALLOWED|NOT YET|NOT ALLOWED/.test(await text(hud, '#hud-perms li[data-perm="mic"] .chip')), await text(hud, '#hud-perms li[data-perm="mic"] .chip'));
  await shot(hud, 'hud-settings-access');
  await hud.click('#sp-back');

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
    await hud.click('#yt-stop');
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
  await hud.waitForFunction(() => document.querySelector('[data-key="nativeVoice"]').options.length > 3, null, { timeout: 8000 }).catch(() => {});
  check('settings show the saved voice engine', await hud.evaluate(() => document.querySelector('[data-key="ttsEngine"]').value) === 'native');
  const nvv = await hud.evaluate(() => { const e = document.querySelector('[data-key="nativeVoice"]'); return e.value + ' | ' + e.options.length; });
  check('macOS voice list filled and saved voice selected', /^Daniel/.test(nvv), nvv);
  check('only the current engine\'s voice rows show', await hud.evaluate(() => [...document.querySelectorAll('[data-tts]')].filter((li) => !li.hidden).every((li) => li.dataset.tts === 'native')));
  const setField = (key, value) => hud.evaluate(([k, v]) => { const el = document.querySelector(`[data-key="${k}"]`); if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new Event('change')); }, [key, value]);
  m = s.mark();
  await setField('commandSilenceSeconds', '1.5');
  await sleep(500);
  check('pause before sending saved', s.config().commandSilenceSeconds === 1.5, s.config().commandSilenceSeconds);
  await setField('commandSilenceSeconds', '-7');
  await sleep(500);
  check('junk pause is clamped', s.config().commandSilenceSeconds === 0.5, s.config().commandSilenceSeconds);
  check('clamped value shown back in the HUD', await hud.evaluate(() => document.querySelector('[data-key="commandSilenceSeconds"]').value) === '0.5');
  await hud.click('.setcard[data-section="ears"]');
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
  check('edge voice row shows', await hud.evaluate(() => !document.querySelector('[data-tts="edge"]').hidden && document.querySelector('[data-tts="native"]').hidden));
  await setField('ttsEngine', 'native');
  await hud.click('#sp-back');
  await hud.click('.setcard[data-section="voice"]');
  await hud.click('#test-voice');
  check('test voice speaks', await s.waitLog(/native synth/, 8000, m));
  await hud.click('#sp-back');
  await hud.click('.setcard[data-section="brain"]');
  await hud.waitForFunction(() => !document.getElementById('b-save').disabled, null, { timeout: 8000 }).catch(() => {});
  await hud.selectOption('#b-model', 'haiku');
  await hud.click('#b-save');
  await sleep(800);
  check('brain model saved', s.config().model === 'haiku');
  check('brain label updates', await s.waitLog(/settings: applied model/, 3000, m));
  await hud.click('#sp-back');
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

  // The right panel shows the conversation, not tool traffic, and lists JARVIS and the crew
  await sleep(500);
  check('the right panel shows my words and the reply', await hud.evaluate(() => {
    const li = [...document.querySelectorAll('#livelog li.msg')];
    return li.some((x) => x.classList.contains('you') && /capital of france/i.test(x.textContent)) && li.some((x) => x.classList.contains('jarvis') && /paris/i.test(x.textContent));
  }), await text(hud, '#live-name'));
  await hud.click('#live-btn');
  const picks = await hud.evaluate(() => [...document.querySelectorAll('#live-pop button')].map((b) => b.querySelector('span:nth-child(2)').textContent));
  check('the picker lists JARVIS and the crew', ['JARVIS', 'FRIDAY', 'KAREN', 'EDITH', 'VISION'].every((n) => picks.includes(n)), picks.slice(0, 6).join(', '));
  await hud.click('#live-pop button:nth-of-type(3)');
  await sleep(600);
  check('picking KAREN shows her conversation', await text(hud, '#live-name') === 'KAREN', await text(hud, '#live-name'));
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
  check('crew shows FRIDAY, EDITH and KAREN', await hud.evaluate(() => ['friday', 'edith', 'karen'].every((id) => getComputedStyle(document.getElementById('crew-' + id)).opacity === '1')));
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
  let sm = s.mark();
  await hud.mouse.click(karen[0], karen[1]);
  await sleep(1300);
  check('clicking KAREN spotlights her', await hud.evaluate(() => document.body.classList.contains('spot') && document.getElementById('crew-karen').classList.contains('spot')));
  const at = await hud.evaluate(() => { const c = document.querySelector('#crew-karen .core').getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); return [c.x + c.width / 2 - (st.x + st.width / 2), c.y + c.height / 2 - (st.y + st.height / 2), c.width]; });
  check('she moves to the centre and grows', Math.abs(at[0]) < 20 && Math.abs(at[1]) < 60 && at[2] > 20, at.map((n) => Math.round(n)).join(', '));
  check('her name card shows', /KAREN/.test(await text(hud, '#spot-name')) && /SAY OR TYPE TO KAREN/.test(await text(hud, '#spot-hint')));
  check('JARVIS puts the user through to her', await s.waitLog(/talking to karen \(HUD\)/, 3000, sm));
  check('her chat opens and typing goes to her', /KAREN/.test(await text(hud, '#live-name')) && /Type to KAREN/.test(await hud.getAttribute('#ask-input', 'placeholder')));
  await shot(hud, 'hud-spotlight');
  await hud.evaluate(() => window.hud.event({ type: 'talking', agent: 'edith' }));
  await sleep(1000);
  check('"talk to EDITH" moves the spotlight to her', await hud.evaluate(() => document.getElementById('crew-edith').classList.contains('spot') && !document.getElementById('crew-karen').classList.contains('spot')));
  sm = s.mark();
  await hud.keyboard.press('Escape');
  await sleep(900);
  check('Esc goes back to JARVIS', await hud.evaluate(() => !document.body.classList.contains('spot')) && await s.waitLog(/talking to (karen|edith): ended/, 3000, sm));
  await hud.click('#live-btn');
  await hud.click('#live-pop button:nth-of-type(1)');
  await hud.mouse.move(mid[0], mid[1]);
  await sleep(2400);
  await hud.mouse.move(log[0], log[1] - 250);
  await sleep(300);
  check('moving onto a panel brings the panels back', !(await isFocus()));
  await hud.click('#nav a[data-view="settings"]');
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

// JARVIS on a local Ollama brain with FRIDAY, a Claude Code worker on Opus, doing the heavy job.
// Needs Ollama running with llama3.2 and a signed-in Claude Code; skipped otherwise.
async function testFriday() {
  console.log('\nOLLAMA BRAIN + FRIDAY ON OPUS');
  const tags = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json()).catch(() => null);
  if (!tags || !(tags.models || []).some((m) => m.name.startsWith('llama3.2'))) { console.log('  - skipped: Ollama with llama3.2 is not running'); return; }
  const state = makeState({ onboarded: true, brainProvider: 'ollama', ollamaModel: 'llama3.2', worker: 'claude-code', agentModel: 'opus', ttsEngine: 'native' });
  const s = await launch(state, [], { JARVIS_TEST_UPDATE_MS: '15000' });
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  if (!hud) { check('HUD opens', false); await s.app.close(); return; }
  check('brain is Ollama', await s.waitLog(/brain: provider ollama/, 10000));
  check('FRIDAY is the worker, on Opus', await s.waitLog(/brain: worker FRIDAY on Claude Code · opus/, 10000));
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
  check('a small question is answered by the local brain', small && !/friday: started/.test(s.log().slice(m)), small && `${small[1]} s`);
  await s.quiet(hud, 30000);

  // A heavy job goes to FRIDAY
  m = s.mark();
  await s.say('please research the current top story on hacker news, read the article, and tell me what it is about over');
  const started = await s.waitLog(/friday: started '([^']*)'.*model=(\w+)/, 90000, m);
  check('a heavy job is handed to FRIDAY', started, started && started[1]);
  check('FRIDAY runs on Opus', started && started[2] === 'opus', started && started[2]);
  await sleep(4000);
  check('the HUD shows the job', /1 JOB/.test(await text(hud, '#br-worker')), await text(hud, '#br-worker'));
  check('FRIDAY lights up in the crew', await hud.evaluate(() => document.getElementById('crew-friday').classList.contains('on')));
  await s.quiet(hud, 30000);
  const sm = s.mark();
  await s.say("what's the status over");
  const st = await s.waitLog(/status: '(.*)'/, 8000, sm);
  check('"what\'s the status?" answers from FRIDAY\'s progress', st, st && st[1]);
  const done = await s.waitLog(/friday: (completed|failed) '([^']*)'/, 300000, m);
  check('FRIDAY finishes the job', done && done[1] === 'completed', done && done[1]);
  const told = await s.waitLog(/proactive: \(FRIDAY\)[\s\S]*timing: ollama done/, 90000, m);
  await sleep(1000);
  const reply = await text(hud, '#reply');
  check('JARVIS tells the user the result in its own words', told && reply.length > 20 && !/RESULT/.test(reply), reply.slice(0, 200));
  await hud.click('#live-btn');
  await hud.click('#live-pop button:nth-of-type(2)');
  await hud.waitForFunction(() => document.querySelector('#livelog li.msg.crew'), null, { timeout: 5000 }).catch(() => {});
  const convo = await hud.evaluate(() => [...document.querySelectorAll('#livelog li.msg')].map((x) => x.className + ': ' + x.textContent));
  check("FRIDAY's conversation shows the task and her report", convo.some((x) => /jarvis/.test(x) && /hacker news/i.test(x)) && convo.some((x) => /crew/.test(x) && /RESULT/.test(x)), convo.slice(-2).map((x) => x.slice(0, 60)).join(' | '));
  await shot(hud, 'friday-conversation');
  await s.app.close();
}

async function testDirect() {
  console.log('\nTALKING TO THE CREW DIRECTLY (Claude Code brain, crew on Haiku)');
  const state = makeState({ onboarded: true, brainProvider: 'claude-code', agentModel: 'haiku', ttsEngine: 'native', checkIns: 'off' });
  const s = await launch(state);
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  if (!hud) { check('HUD opens', false); await s.app.close(); return; }
  await hud.waitForFunction(() => document.body.dataset.state !== 'booting', null, { timeout: 15000 }).catch(() => {});
  const type = async (t) => { await hud.fill('#ask-input', t); await hud.press('#ask-input', 'Enter'); };
  const chat = () => hud.evaluate(() => [...document.querySelectorAll('#livelog li.msg')].map((x) => x.className.replace('msg ', '') + ': ' + x.querySelector('.x').textContent));

  // By name: "EDITH, ..." goes straight to her, not through JARVIS
  let m = s.mark();
  await type('edith, reply with exactly the word pineapple and nothing else');
  check('"EDITH, ..." goes to EDITH directly', await s.waitLog(/edith chat: 'reply with exactly/, 8000, m));
  check('JARVIS does not route it', !/brain: asked 'edith/.test(s.log().slice(m)));
  check('EDITH replies', await s.waitLog(/edith chat: replied/, 120000, m));
  await sleep(800);
  let c = await chat();
  check("her chat shows the user's message and her reply", c.some((x) => /^you: reply with exactly/.test(x)) && c.some((x) => /^crew: .*pineapple/i.test(x)), c.slice(-2).join(' | '));
  check('the panel shows EDITH and typing goes to her', /EDITH/.test(await text(hud, '#live-name')) && /Type to EDITH/.test(await hud.getAttribute('#ask-input', 'placeholder')));

  // "Talk to FRIDAY": everything goes to her, and she remembers the conversation
  m = s.mark();
  await type('talk to friday');
  check('"talk to FRIDAY" puts the user through', await s.waitLog(/talking to friday/, 5000, m));
  await type('remember that the code word is mango. just say ok.');
  check('the next message goes to FRIDAY', await s.waitLog(/friday chat: 'remember that the code word/, 8000, m));
  await s.waitLog(/friday chat: replied/, 120000, m);
  m = s.mark();
  await type('what is the code word? answer with one word.');
  const resumed = await s.waitLog(/friday chat: 'what is the code word.*session=([\w-]+)/, 8000, m);
  check('her second message resumes her own session', resumed && resumed[1] !== 'new', resumed && resumed[1]);
  await s.waitLog(/friday chat: replied/, 120000, m);
  await sleep(800);
  c = await chat();
  check('FRIDAY remembers what was said earlier', /mango/i.test(c[c.length - 1] || ''), c[c.length - 1]);
  await shot(hud, 'direct-friday');
  m = s.mark();
  await type("that's all, friday");
  check('"that\'s all, FRIDAY" comes back to JARVIS', await s.waitLog(/talking to friday: ended/, 5000, m));
  check('typing goes to JARVIS again', /Type to JARVIS/.test(await hud.getAttribute('#ask-input', 'placeholder')));

  // "Friday" as a day stays with JARVIS
  m = s.mark();
  await type('friday at nine works for me');
  check('"friday at nine ..." is for JARVIS', await s.waitLog(/brain: asked 'friday at nine/, 8000, m));
  await s.waitLog(/timing: claude done/, 90000, m);
  await s.app.close();
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
  if (which === 'friday' || which === 'all') await testFriday();
  if (which === 'direct' || which === 'all') await testDirect();
} catch (e) {
  check('test run crashed', false, e.message.split('\n')[0]);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
