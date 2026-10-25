// Tools for the Anthropic API and Ollama brains (Claude Code brings its own).
// Deliberately small and sandboxed: fixed script allowlist, no shell, no file
// writes except through memory.py and remind.py.
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { run, paths } = require('../util');

// Same reach as the Claude Code brain: everything in scripts/ except opening terminals.
const SCRIPTS = ['sessions.sh', 'terminals.sh', 'read.sh', 'send.sh', 'keys.sh', 'mac.sh', 'memory.py', 'remind.py'];

const SPECS = [
  {
    name: 'run_script',
    description: `Run one of the JARVIS helper scripts. Allowed: ${SCRIPTS.join(', ')}. Pass arguments as a list of strings.`,
    schema: {
      type: 'object',
      properties: {
        script: { type: 'string', enum: SCRIPTS },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['script'],
    },
  },
  {
    name: 'open',
    description: 'Open a website (https URL) in the default browser, or an app by name (e.g. "Spotify", "Google Chrome"). Optional "app" opens the URL in that app.',
    schema: { type: 'object', properties: { target: { type: 'string' }, app: { type: 'string' } }, required: ['target'] },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page or API over https and return its text (first 15000 characters).',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'read_file',
    description: "Read a text file inside the user's home folder (first 20000 characters).",
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'remember',
    description: 'Save one durable fact about the user (name, preference, project nickname) to long-term memory.',
    schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
];

const TOOL_NOTE = `In this mode you do not have Bash. Use the tools instead:
- run_script runs the helper scripts described above (give the script name, not the path, and the arguments as a list).
- open opens websites and apps. web_fetch reads a page. read_file reads a file. remember saves a fact.
- You have no background agents and no Agent tool: ignore TIER 2. Do short jobs yourself with these tools. For anything that needs clicking or typing in a website, say in one sentence that it needs the Claude Code brain.`;

async function execute(name, input = {}) {
  try {
    switch (name) {
      case 'run_script': {
        if (!SCRIPTS.includes(input.script)) return 'Error: script not allowed.';
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        const file = path.join(paths.scripts, input.script);
        const r = input.script.endsWith('.py') ? await run('/usr/bin/python3', ['-I', file, ...args], { timeout: 60000 }) : await run('/bin/sh', [file, ...args], { timeout: 60000 });
        return (r.out + (r.code !== 0 ? `\n[exit ${r.code}] ${r.err}` : '')).slice(0, 12000) || '(no output)';
      }
      case 'open': {
        const t = String(input.target || '');
        if (/^https?:\/\//i.test(t)) {
          const r = await run('/usr/bin/open', input.app ? ['-a', String(input.app), t] : [t], { timeout: 15000 });
          return r.code === 0 ? 'Opened.' : `Error: ${r.err}`;
        }
        if (/^[\w .&'-]{1,60}$/.test(t)) {
          const r = await run('/usr/bin/open', ['-a', t], { timeout: 15000 });
          return r.code === 0 ? 'Opened.' : `Error: ${r.err}`;
        }
        return 'Error: target must be an https URL or an app name.';
      }
      case 'web_fetch': {
        const u = new URL(String(input.url));
        if (!/^https?:$/.test(u.protocol)) return 'Error: only http(s) URLs.';
        const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 JARVIS' }, signal: AbortSignal.timeout(15000) });
        let text = await res.text();
        if (/html/i.test(res.headers.get('content-type') || '')) {
          text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
        }
        return `[${res.status}] ${text.slice(0, 15000)}`;
      }
      case 'read_file': {
        const p = path.resolve(String(input.path || '').replace(/^~(?=\/|$)/, C.HOME));
        if (!p.startsWith(C.HOME + path.sep)) return 'Error: only files inside the home folder.';
        return fs.readFileSync(p, 'utf8').slice(0, 20000);
      }
      case 'remember': {
        const fact = String(input.fact || '').replace(/\n/g, ' ').trim();
        if (!fact) return 'Error: empty fact.';
        const r = await run('/usr/bin/python3', ['-I', path.join(paths.scripts, 'memory.py'), 'add', fact], { timeout: 10000 });
        return r.code === 0 ? r.out.trim() : `Error: ${r.err.trim()}`;
      }
      default: return `Error: unknown tool ${name}.`;
    }
  } catch (e) {
    return `Error: ${e.message || e}`;
  }
}

module.exports = { SPECS, TOOL_NOTE, execute };
