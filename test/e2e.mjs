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
  const auto = await text(w, '#auto-pick');
  check('Automatic shows what it will pick', auto.startsWith('→'), auto);

  // Brain: random Anthropic key must be rejected
  await w.click('[data-brain="anthropic"]');
  check('Anthropic card selectable', await w.locator('[data-brain="anthropic"].on').count() === 1);
  check('Anthropic settings group visible', await w.isVisible('[data-for="anthropic"]'));
  await w.fill('#anthropicApiKey', 'sk-ant-random-1234567890');
  await w.click('[data-test="anthropic"]');
  await w.waitForFunction(() => !/testing/.test(document.getElementById('api-status').textContent), null, { timeout: 15000 }).catch(() => {});
  const apiStatus = await text(w, '#api-status');
  check('random Anthropic key is rejected', /✗/.test(apiStatus), apiStatus);
  await w.fill('#anthropicModel', 'claude-random-999');

  // Brain: Ollama on a dead port
  await w.click('[data-brain="ollama"]');
  await w.fill('#ollamaUrl', 'http://127.0.0.1:9');
  await w.click('[data-test="ollama"]');
  await w.waitForFunction(() => !/testing/.test(document.getElementById('ollama-status').textContent), null, { timeout: 10000 }).catch(() => {});
  const ol = await text(w, '#ollama-status');
  check('Ollama on a dead port reports failure', /✗|not running/.test(ol), ol);
  await w.click('[data-brain="anthropic"]');
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
  check('Back returns to Voice', await w.isVisible('section.on[data-step="voice"]'));
  await w.click('#next');
  await w.click('#next');

  // Finish
  check('Next goes to Finish', await w.isVisible('section.on[data-step="finish"]'));
  const summary = await text(w, '#summary');
  check('summary shows the name', summary.includes('Tester 42'), summary.slice(0, 120));
  check('summary shows the chosen brain', summary.includes('Anthropic API'));
  check('summary shows Telegram configured', summary.includes('configured'));
  await shot(w, 'onb-5-finish');

  // Saved config (written on every Next)
  const c = s.config();
  check('name saved', c.userName === 'Tester 42');
  check('honorific saved', c.honorific === 'boss');
  check('brain saved', c.brainProvider === 'anthropic');
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
    check('brain provider is the chosen one', brainLine && brainLine[1] === 'anthropic', brainLine && brainLine[1]);
    await hud.waitForFunction(() => document.body.dataset.state !== 'booting', null, { timeout: 15000 }).catch(() => {});
    const w0 = s.mark();
    await s.say('jarvis wake up');
    await s.waitLog(/conversation mode on/, 8000);
    await s.waitLog(/synth/, 8000, w0);        // "Yes, sir?" has started; wait for it to end
    await s.quiet(hud);
    const m = s.mark();
    await s.say('what is the capital of france over');
    const err = await s.waitLog(/brain error: (.*)/, 20000, m);
    const tgStop = await s.waitLog(/telegram: token rejected/, 3000);
    check('bad Telegram token stops polling (no API hammering)', tgStop && (s.log().match(/getUpdates: Unauthorized/g) || []).length <= 1);
    check('random API key gives a clear error', err && /rejected|401/.test(err[1]), err && err[1]);
    await sleep(500);
    const reply = await text(hud, '#reply');
    check('error is shown on the HUD', /Anthropic|rejected|key/i.test(reply), reply.slice(0, 100));
    await shot(hud, 'onb-6-hud-after');
  }
  await s.app.close();
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
  // Brain: Anthropic with NO key
  await w.click('[data-brain="anthropic"]');
  await w.fill('#anthropicModel', '');
  await w.click('#next');
  // Listening: ElevenLabs with no key, negative silence
  await w.click('[data-stt="elevenlabs"]');
  await w.fill('#commandSilenceSeconds', '-5');
  await w.click('#next');
  // Voice: absurd Kokoro speed
  await w.click('[data-tts="kokoro"]');
  await w.fill('#kokoroSpeed', '99');
  await w.click('#next');
  // Extras: letters in chat id
  await setNum('#telegramChatId', 'abc');
  await w.click('#next');

  // Finish must refuse: no Anthropic key
  await w.click('#next');
  await sleep(500);
  let msg = await text(w, '#saved');
  check('refuses Anthropic brain without a key', /Anthropic API key/.test(msg), msg);
  check('no HUD started while setup is invalid', !(await windowByUrl(s.app, /hud\/index\.html/, 1500)));

  // Fix brain → next problem: ElevenLabs key
  await w.click('#steps li[data-step="brain"]');
  await w.click('[data-brain="claude-code"]');
  await w.click('#steps li[data-step="finish"]');
  await w.click('#next');
  await sleep(500);
  msg = await text(w, '#saved');
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

  // Reopen Setup from the running app: stored keys show as stored, empty field keeps them
  if (hud) {
    await hud.click('#nav a[data-view="settings"]');
    await hud.click('#open-setup');
    const w2 = await windowByUrl(s.app, /setup\.html\?first=0/, 8000);
    check('Setup reopens from the HUD', w2);
    if (w2) {
      await w2.waitForSelector('section.on');
      await w2.click('#steps li[data-step="ears"]');
      const stored = await text(w2, '#elevenLabsApiKey-stored');
      check('reopened Setup shows the key as stored', /stored/.test(stored), stored);
      const before = s.config().elevenLabsApiKey;
      await w2.click('#next');
      check('saving with empty key field keeps the key', s.config().elevenLabsApiKey === before);
      const v = await w2.inputValue('#kokoroSpeed').catch(() => '');
      check('reopened Setup shows clamped speed', Number(v) <= 2, v);
    }
  }
  await s.app.close();
}


async function testThemes() {
  console.log('\nTHEMES (screenshots of every theme, dark and light)');
  const s = await launch(makeState({ onboarded: true, brainProvider: 'claude-code', ttsEngine: 'native' }));
  const hud = await windowByUrl(s.app, /hud\/index\.html/, 20000);
  if (!hud) { check('HUD opens', false); await s.app.close(); return; }
  await hud.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 15000 }).catch(() => {});
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#open-setup');
  const w = await windowByUrl(s.app, /setup\.html\?first=0/, 8000);
  if (!w) { check('Setup opens', false); await s.app.close(); return; }
  await w.waitForSelector('section.on');
  await w.click('#steps li[data-step="look"]');
  await hud.click('#nav a[data-view="cc"]');
  for (const theme of ['jarvis', 'terminal', 'neon', 'stark', 'minimal']) {
    for (const mode of ['dark', 'light']) {
      await w.click(`[data-theme-pick="${theme}"]`);
      await w.click(`[data-mode-pick="${mode}"]`);
      await sleep(900);
      const h = await hud.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/'));
      check(`HUD follows ${theme}/${mode}`, h === `${theme}/${mode}`, h);
      const bg = await hud.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const light = await hud.evaluate(() => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3 > 128; });
      check(`HUD background is ${mode} for ${theme}`, light === (mode === 'light'), bg);
      await shot(hud, `theme-hud-${theme}-${mode}`);
      await shot(w, `theme-setup-${theme}-${mode}`);
    }
  }
  for (const step of ['brain', 'ears', 'voice', 'extras', 'finish']) {
    await w.click(`#steps li[data-step="${step}"]`);
    await sleep(300);
    await shot(w, `step-${step}-minimal-light`);
  }
  await w.click('#steps li[data-step="look"]');
  await w.click('[data-mode-pick="system"]');
  await sleep(500);
  const sys = await w.evaluate(() => document.documentElement.dataset.mode);
  check('"Match macOS" resolves to dark or light', sys === 'dark' || sys === 'light', sys);

  // Picker in the HUD's SETTINGS tab: applies live, saves, and the open Setup follows
  await hud.click('#nav a[data-view="settings"]');
  await hud.click('#look-themes [data-theme-pick="neon"]');
  await hud.click('#look-modes [data-mode-pick="light"]');
  await sleep(800);
  const hv = await hud.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode].join('/'));
  check('HUD picker applies the theme', hv === 'neon/light', hv);
  const saved = s.config();
  check('HUD picker saves the theme', saved.theme === 'neon' && saved.themeMode === 'light', `${saved.theme}/${saved.themeMode}`);
  const sv = await w.evaluate(() => [document.documentElement.dataset.theme, document.querySelector('[data-theme-pick].on')?.dataset.themePick].join('/'));
  check('open Setup follows the HUD picker', sv === 'neon/neon', sv);
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
  check('brain starts a background agent', await s.waitLog(/brain: agent started/, 60000, m));
  check('brain answers before the agent finishes', await s.waitLog(/timing: claude done/, 60000, m) && !s.log().slice(m).includes('agent completed'));
  check('agent completes', await s.waitLog(/brain: agent completed/, 120000, m));
  const bg = await s.waitLog(/brain: background turn '(.*)/, 60000, m);
  const spokenAt = s.log().indexOf('brain: background turn', m);
  check('agent result is spoken', bg && /20\d\d|year/i.test(bg[1]) && await s.waitLog(/native synth/, 10000, spokenAt), bg && bg[1]);
  const footer = await text(hud, '#br-worker');
  check('HUD footer shows no jobs again', /NO JOBS RUNNING/.test(footer), footer);

  // Longer job: quick spoken reply without technical words, live progress, "what's the status?" answered locally
  await s.quiet(hud);
  m = s.mark();
  await s.say('in the background, run the shell command ping -c 20 localhost three separate times one after another, then tell me the word finished over');
  check('long job starts', await s.waitLog(/brain: agent started/, 60000, m));
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
  check('long job completes', await s.waitLog(/brain: agent completed/, 180000, m));

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
  await shot(hud, 'hud-1-home');

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
  await hud.click('#open-setup');
  const setup = await windowByUrl(s.app, /setup\.html\?first=0/, 8000);
  check('OPEN SETUP opens the setup window', setup);
  if (setup) await setup.close();

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
  await hud.click('#test-voice');
  check('test voice speaks', await s.waitLog(/native synth/, 8000, m));
  await setField('model', 'haiku');
  await sleep(500);
  check('brain model saved', s.config().model === 'haiku');
  check('brain label updates', await s.waitLog(/settings: applied model/, 3000, m));
  await hud.waitForFunction(() => document.getElementById('hands-state').textContent !== 'checking…', null, { timeout: 8000 }).catch(() => {});
  const hs = await text(hud, '#hands-state');
  check('screen access status shown', /allowed|needs/.test(hs), hs);
  await hud.click('label:has([data-key="screenControl"])');
  await sleep(600);
  check('"use apps outside Chrome" can be switched off', s.config().screenControl === false && await s.waitLog(/settings: applied screenControl/, 3000, m));
  check('screen access row hides when off', await hud.evaluate(() => document.getElementById('hands-row').hidden));
  await shot(hud, 'hud-settings-form');

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
  await sleep(300);
  check('moving the mouse brings the panels back', !(await isFocus()));
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
  await shot(hud, 'hud-memory');

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

const which = process.argv[2] || 'all';
const t0 = Date.now();
try {
  if (which === 'onboarding' || which === 'all') await testOnboarding();
  if (which === 'validation' || which === 'all') await testValidation();
  if (which === 'hud' || which === 'all') await testHud();
  if (which === 'themes' || which === 'all') await testThemes();
  if (which === 'voice' || which === 'all') await testVoice();
  if (which === 'proactive' || which === 'all') await testProactive();
} catch (e) {
  check('test run crashed', false, e.message.split('\n')[0]);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
