// Ollama for onboarding: is it installed, is it running, which models it has,
// and doing the work for the user: install the app, start it, download a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { which, run, log } = require('./util');

const DOWNLOAD = 'https://ollama.com/download/Ollama-darwin.zip';
const APP_DIRS = process.env.JARVIS_TEST_APP_DIR ? [process.env.JARVIS_TEST_APP_DIR] : ['/Applications', path.join(os.homedir(), 'Applications')];

// Models offered for download: small enough for a 16 GB Mac, fast to answer, and able to call tools
// without a long "thinking" pass. Tested with JARVIS: Llama 3.2 3B answers in a few seconds and hands
// heavy jobs to FRIDAY. (Qwen3 8B only called tools reliably with thinking on, at over a minute a reply.)
const RECOMMENDED = [
  { id: 'llama3.2', name: 'Llama 3.2 · 3B', size: '2.0 GB', note: 'Fast. Good for everyday questions, and hands heavy jobs to FRIDAY.' },
];

const base = (url) => String(url || 'http://127.0.0.1:11434').replace(/\/$/, '');
const appPath = () => APP_DIRS.map((d) => path.join(d, 'Ollama.app')).find((p) => fs.existsSync(p)) || null;

async function models(url) {
  try {
    const r = await fetch(`${base(url)}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return ((await r.json()).models || []).map((m) => m.name);
  } catch {}
  return null;
}

/** { installed, running, models, recommended } */
async function state(url) {
  const list = await models(url);
  return { installed: !!(appPath() || which('ollama')), running: list !== null, models: list || [], recommended: RECOMMENDED };
}

async function waitRunning(url, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) {
    if ((await models(url)) !== null) return true;
  }
  return false;
}

/** Start the Ollama app (or `ollama serve` for a CLI-only install) and wait for its server. */
async function start(url) {
  if ((await models(url)) !== null) return { ok: true };
  const app = appPath();
  if (app) await run('/usr/bin/open', ['-g', '-a', app], { timeout: 10000 });
  else {
    const bin = which('ollama');
    if (!bin) return { ok: false, msg: 'Ollama is not installed.' };
    require('child_process').spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  }
  const ok = await waitRunning(url);
  log(`ollama: start ${ok ? 'ok' : 'timed out'}`);
  return ok ? { ok: true } : { ok: false, msg: 'Ollama did not start. Open the Ollama app once, then try again.' };
}

/**
 * Download the Ollama app from ollama.com, check macOS accepts its signature,
 * put it in Applications and start it. progress({ phase, pct }) along the way.
 */
async function install(url, progress) {
  if (appPath()) return start(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ollama-'));
  try {
    progress({ phase: 'Downloading Ollama', pct: 0 });
    const res = await fetch(DOWNLOAD, { signal: AbortSignal.timeout(15 * 60000) });
    if (!res.ok) return { ok: false, msg: `Download failed (HTTP ${res.status}).` };
    const total = Number(res.headers.get('content-length')) || 0;
    const zip = path.join(tmp, 'Ollama.zip');
    const out = fs.createWriteStream(zip);
    let got = 0, last = 0;
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      if (total && Date.now() - last > 250) { last = Date.now(); progress({ phase: 'Downloading Ollama', pct: Math.round((got / total) * 100) }); }
    }
    await new Promise((r) => out.end(r));
    progress({ phase: 'Checking the download', pct: 100 });
    const unzip = await run('/usr/bin/ditto', ['-x', '-k', zip, tmp], { timeout: 120000 });
    const app = path.join(tmp, 'Ollama.app');
    if (unzip.code !== 0 || !fs.existsSync(app)) return { ok: false, msg: 'The download could not be unpacked.' };
    // Only install what Gatekeeper accepts: signed with a Developer ID and notarized by Apple.
    const sig = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app], { timeout: 60000 });
    if (sig.code !== 0) { log(`ollama: signature check failed: ${sig.err.trim()}`); return { ok: false, msg: 'macOS did not accept the downloaded app, so it was not installed.' }; }
    progress({ phase: 'Installing', pct: 100 });
    let dest = null;
    for (const dir of APP_DIRS) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        if ((await run('/usr/bin/ditto', [app, path.join(dir, 'Ollama.app')], { timeout: 120000 })).code === 0) { dest = dir; break; }
      } catch {}
    }
    if (!dest) return { ok: false, msg: 'Could not copy Ollama into Applications.' };
    log(`ollama: installed into ${dest}`);
    progress({ phase: 'Starting Ollama', pct: 100 });
    return start(url);
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Download a model through the running server. progress({ phase, pct }). */
async function pull(url, model, progress) {
  if (!/^[\w.:/-]{1,80}$/.test(model || '')) return { ok: false, msg: 'Not a model name.' };
  try {
    const res = await fetch(`${base(url)}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
    const parts = new Map();
    let buf = '', last = 0, error = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) error = o.error;
        if (o.digest && o.total) parts.set(o.digest, { total: o.total, done: o.completed || 0 });
        if (Date.now() - last > 250) {
          last = Date.now();
          let t = 0, d = 0;
          for (const p of parts.values()) { t += p.total; d += p.done; }
          progress({ phase: `Downloading ${model}`, pct: t ? Math.round((d / t) * 100) : 0 });
        }
      }
    }
    if (error) return { ok: false, msg: error };
    const have = (await models(url)) || [];
    const ok = have.some((m) => m === model || m.startsWith(model + ':'));
    log(`ollama: pull ${model} ${ok ? 'ok' : 'failed'}`);
    return ok ? { ok: true, models: have } : { ok: false, msg: 'The model did not finish downloading.' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

module.exports = { state, start, install, pull, RECOMMENDED };
