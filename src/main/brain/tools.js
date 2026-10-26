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

// With the crew available, TIER 2 goes through the delegate tool instead of the Agent tool.
const DELEGATE = {
  name: 'delegate',
  description: "Hand a task to JARVIS's crew, who do it in the background on a stronger model and report back. to: friday (coding, web search and research, files, heavy jobs), karen (all communication: email, WhatsApp and other chats, every social media account, posts, replies and self-branding), edith (reviews, fact-checks, safety and security), vision (anything inside a website, in the user's signed-in Chrome). Use it for every task beyond a simple answer.",
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', enum: ['friday', 'karen', 'edith', 'vision'], description: 'Who takes the job. If unsure, friday.' },
      description: { type: 'string', description: 'What they are doing, in plain words with an -ing verb, read aloud in status updates. For example "checking your Gmail".' },
      task: { type: 'string', description: 'One complete, self-contained instruction. The crew cannot see this conversation, so include every detail. Only say the user confirmed sending, posting, deleting or paying if they did.' },
    },
    required: ['description', 'task'],
  },
};

const DELEGATE_NOTE = `In this mode you do not have Bash. Use the tools instead:
- run_script runs the helper scripts described above (give the script name, not the path, and the arguments as a list).
- open opens websites and apps. web_fetch reads a page. read_file reads a file. remember saves a fact.
- TIER 2 works through the delegate tool, not the Agent tool. Pick the crew member with "to" (friday, karen, edith or vision); they take the job in the background and report back, and you then tell the user the result in your own words. Everything TIER 2 says about agents applies: say ONE short sentence of what's happening, then call delegate, then end the turn with two or three words such as "On it." Never wait for the crew.
- Every task goes to delegate: web searches, websites, email and messages, coding, files, anything beyond a simple answer.
- Ask the user before delegating anything that sends, posts, deletes, publishes, pays or changes account settings, exactly as the rules above say; when they agree, write "The user confirmed: …" in the task.`;

async function execute(name, input = {}) {
  try {
    switch (name) {
      case 'run_script': {
        if (!SCRIPTS.includes(input.script)) return 'Error: script not allowed.';
        // Small models sometimes send the arguments as one string; split it the way a shell would, roughly.
        const args = Array.isArray(input.args) ? input.args.map(String) : typeof input.args === 'string' ? (input.args.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2')) : [];
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

/** Tool specs and the note for the system prompt, with or without the crew. */
const forBrain = (hasWorker) => (hasWorker ? { specs: [...SPECS, DELEGATE], note: DELEGATE_NOTE } : { specs: SPECS, note: TOOL_NOTE });

module.exports = { SPECS, TOOL_NOTE, execute, forBrain };
