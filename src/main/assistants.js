// The assistants to choose from. Every one of them does everything, with the same tools, the same
// background worker, the same memory and the same safety rules. They differ only in how they run:
// the brain and its model, how hard it thinks, the worker's model, the voice, and the name you call.
//
// The live config is the defaults, then the chosen assistant's preset, then the user's own changes
// for that assistant (cfg.assistantSettings[id]). SCOPED lists the settings that belong to an assistant.
// The user's changes can also replace the persona prompt (assistantSettings[id].persona) and set the
// assistant's role, quick commands, tools and colour (PROFILE). Assistants the user made
// live in cfg.customAssistants, each a full copy of the one it started from.

const SCOPED = ['brainProvider', 'model', 'effort', 'agentModel', 'worker', 'anthropicModel', 'geminiModel', 'ollamaModel',
  'kokoroVoice', 'kokoroSpeed', 'edgeVoice', 'nativeVoice', 'elevenLabsVoiceId', 'wakeWords'];

// What an assistant specialises in. A role shapes what it pays attention to and offers to do; every
// assistant can still do any task. 'custom' uses the user's own words (assistantSettings[id].roleText).
const ROLES = {
  none: { label: 'None', focus: '' },
  communications: {
    label: 'Communications',
    focus: "Your speciality is the user's communications: email, messages, WhatsApp, Telegram, LinkedIn and social media. Triage what comes in into what needs the user, what can wait and what is noise. Draft replies in the user's own tone, learnt from what they have sent before. Keep track of who is waiting on a reply from the user and since when, and chase the follow-ups they owe or are owed. Reading an inbox or drafting a reply that matters goes to your background worker, which has the browser and a stronger model.",
  },
  coding: {
    label: 'Coding',
    focus: "Your speciality is the user's code: building, reviewing and fixing it, running the tests, and keeping branches and pull requests moving. You keep an eye on their Claude Code sessions and say plainly what passed, what failed and what is next.",
  },
  research: {
    label: 'Research',
    focus: 'Your speciality is research: digging into a topic, comparing sources, and saying how sure you are and where each fact came from. Lead with the answer, then the evidence.',
  },
  security: {
    label: 'Security & privacy',
    focus: "Your speciality is the user's security and privacy: spotting risks in what they are about to do, checking what apps and sites can reach, and keeping secrets out of messages, files and screenshots. Say how sure you are and never play a risk down.",
  },
  maintainer: {
    label: 'Maintains JARVIS',
    focus: "Your speciality is looking after JARVIS itself and this Mac. When the user wants JARVIS changed, you change its code (see MAINTAINING JARVIS). You also check that JARVIS is healthy (maintain.sh status: errors in the log, CPU and RAM, the brain, voice and ears), keep the memory tidy (duplicates, outdated facts; ask before forgetting anything), and look after the Mac's RAM, CPU, disk and junk.",
  },
  custom: { label: 'Your own', focus: '' },
};

// Tools an assistant can be kept away from. Each blocks what it names for the assistant's brain and its
// background worker (deny rules, which hold in bypass mode too), and the prompt says it is switched off.
const TOOLS = {
  browser: { label: 'Web and your browser', about: 'Search, read pages, and use your signed-in Chrome for email and social media', deny: ['WebSearch', 'WebFetch', 'mcp__claude-in-chrome'], api: ['web_fetch'] },
  terminals: { label: 'Your Claude Code terminals', about: 'Type into, press keys in and close your Claude Code sessions', deny: ['Bash(*send.sh*)', 'Bash(*keys.sh*)', 'Bash(*close-session.sh*)'], scripts: ['send.sh', 'keys.sh'] },
  mac: { label: 'Mac controls', about: 'Volume, apps, and checking and cleaning the Mac', deny: ['Bash(*mac.sh*)', 'Bash(*system.sh*)'], scripts: ['mac.sh'] },
  screen: { label: 'Screen control', about: 'Click, type and read other apps (also needs Screen control on in Settings › Access)', deny: ['Bash(*hands.sh*)', 'Bash(*jarvis-hands*)'] },
  files: { label: 'Editing files', about: 'Write and change files on this Mac', deny: ['Edit', 'Write', 'NotebookEdit'] },
  reminders: { label: 'Reminders and routines', about: 'Set reminders and scheduled tasks', deny: ['Bash(*remind.py*)'], scripts: ['remind.py'] },
};

// Guardrails: how careful the assistant is. Each only adds limits on top of JARVIS's own safety rules
// (ask before sending, posting, deleting or paying; never edit JARVIS or ~/.claude), never fewer.
const GUARDS = {
  standard: { label: 'Standard', about: 'Asks before it sends, posts, deletes, pays or changes an account', rule: '' },
  careful: { label: 'Careful', about: 'Also asks before any change: files, apps, sessions, settings', rule: 'GUARDRAIL (careful): before ANY action that changes something (a file, an app, a terminal session, a setting, a reminder, a message), say in one sentence what you will do and ask "Shall I go ahead?". Only looking, reading and answering need no yes.' },
  readonly: { label: 'Read only', about: 'Looks and answers, but never changes anything', rule: 'GUARDRAIL (read only): you may look, read and answer, but never change anything: no editing or deleting files, no typing into terminals, no sending or posting, no changing apps, settings or reminders. If the user asks for a change, say it is read only and that they can change that in the Agents tab.',
    deny: ['Edit', 'Write', 'NotebookEdit', 'Bash(*send.sh*)', 'Bash(*keys.sh*)', 'Bash(*close-session.sh*)', 'Bash(*mac.sh*)', 'Bash(*hands.sh*)', 'Bash(*jarvis-hands*)', 'Bash(*remind.py*)', 'Bash(rm *)', 'Bash(mv *)'],
    scripts: ['send.sh', 'keys.sh', 'mac.sh', 'remind.py'] },
};

// The per-assistant fields saveProfile keeps, besides SCOPED settings.
const PROFILE = ['persona', 'skills', 'mcp', 'wakeWords', 'role', 'roleText', 'commands', 'tools', 'color', 'sharedMemory', 'guard', 'blockedPaths', 'maintainer'];

const ASSISTANTS = {
  jarvis: {
    name: 'JARVIS',
    hello: 'Quick and thorough, as ever.',
    tier: 'BALANCED',
    role: 'none',
    about: 'Fast and smart. Quick replies, strong background work.',
    needs: 'Claude Code (or an API key)',
    persona: "Think of the JARVIS who served Tony Stark: a loyal, quick-witted British companion who runs the house, the work and the details, so the user can think about bigger things. Dry, understated British wit.",
    settings: {
      brainProvider: 'auto', model: 'sonnet', effort: 'medium', agentModel: 'opus',
      kokoroVoice: 'bm_george', edgeVoice: 'en-GB-RyanNeural', nativeVoice: 'Daniel', elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
      wakeWords: ['jarvis', 'jervis', 'jarvus', 'jar vis'],
    },
  },
  friday: {
    name: 'FRIDAY',
    hello: 'Code and the hard problems are mine. Give me a moment on the big ones.',
    tier: 'MAXIMUM',
    role: 'coding',
    about: 'The smartest, for code and hard problems. Thinks hardest, so she answers more slowly.',
    needs: 'Claude Code',
    persona: 'Think of FRIDAY, who took over from JARVIS in Tony Stark\'s lab: quick, direct and practical, with a light Irish warmth. She gets on with it and says plainly what she found.',
    settings: {
      brainProvider: 'auto', model: 'opus', effort: 'high', agentModel: 'opus',
      kokoroVoice: 'bf_emma', edgeVoice: 'en-IE-EmilyNeural', nativeVoice: 'Moira', elevenLabsVoiceId: 'pFZP5JQG7iQjIQuC4Bku',
      wakeWords: ['friday', 'fri day'],
    },
  },
  karen: {
    name: 'KAREN',
    hello: 'Your inbox, messages and replies are my thing. Ask me anything else too.',
    tier: 'LIGHT',
    role: 'communications',
    about: 'Your communications: email, messages and social media. The fastest and lightest.',
    needs: 'Claude Code',
    persona: 'Think of KAREN, the suit AI Peter Parker named: friendly, upbeat and tactful, warm with people, and quick to help. She knows who is waiting on whom and keeps every reply in the user\'s own voice.',
    settings: {
      brainProvider: 'auto', model: 'haiku', effort: 'low', agentModel: 'sonnet',
      kokoroVoice: 'af_heart', edgeVoice: 'en-US-JennyNeural', nativeVoice: 'Samantha', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL',
      wakeWords: ['karen', 'caren', 'karin', 'carin'],
    },
  },
  edith: {
    name: 'EDITH',
    hello: 'I look after JARVIS and this Mac. Ask me to change anything in JARVIS.',
    tier: 'MAINTAINER',
    role: 'maintainer',
    // The one agent that may change JARVIS's own code, through pull requests the user merges.
    maintainer: true,
    about: 'Maintains JARVIS: changes its code when you ask, keeps it healthy, tidies memory and looks after the Mac.',
    needs: 'Claude Code',
    persona: "Think of EDITH, the security AI Tony Stark left behind: careful, precise and calm. She says how sure she is and never hides a risk.",
    settings: {
      brainProvider: 'claude-code', model: 'opus', effort: 'high', agentModel: 'opus',
      kokoroVoice: 'bf_isabella', edgeVoice: 'en-GB-SoniaNeural', nativeVoice: 'Tessa', elevenLabsVoiceId: 'Xb7hH8MSUJpSbSDYk0k2',
      wakeWords: ['edith', 'edeth', 'eadith'],
    },
  },
  vision: {
    name: 'VISION',
    hello: "Research is my speciality, and I run on Google's Gemini.",
    tier: 'NO CLAUDE NEEDED',
    role: 'research',
    about: "Research, on Google's Gemini with a free tier. For when you don't have Claude.",
    needs: 'A Gemini API key',
    persona: 'Think of Vision: thoughtful, calm and exact, a little philosophical, kind, and always precise about what he knows.',
    settings: {
      brainProvider: 'gemini', geminiModel: 'gemini-flash-latest', worker: 'claude-code', agentModel: 'opus',
      kokoroVoice: 'am_michael', edgeVoice: 'en-US-GuyNeural', nativeVoice: 'Rishi', elevenLabsVoiceId: 'nPczCjzI2devNBz1zQrb',
      wakeWords: ['vision', 'visions'],
    },
  },
};

const IDS = Object.keys(ASSISTANTS);
const customOf = (cfg) => (cfg && cfg.customAssistants && typeof cfg.customAssistants === 'object' ? cfg.customAssistants : {});
const exists = (id, cfg) => !!(ASSISTANTS[id] || customOf(cfg)[id]);

/**
 * One assistant, with the user's own changes to its persona, role, quick commands, tools and
 * colour. cfg gives the custom ones.
 */
function assistantOf(id, cfg) {
  const a = ASSISTANTS[id] || customOf(cfg)[id] || ASSISTANTS.jarvis;
  const mine = (cfg && cfg.assistantSettings && cfg.assistantSettings[id]) || {};
  const out = { ...a, role: ROLES[mine.role] ? mine.role : ROLES[a.role] ? a.role : 'none' };
  if (typeof mine.persona === 'string' && mine.persona.trim()) out.persona = mine.persona.trim();
  out.roleText = typeof mine.roleText === 'string' ? mine.roleText : a.roleText || '';
  out.sharedMemory = mine.sharedMemory !== false;
  out.guard = GUARDS[mine.guard] ? mine.guard : GUARDS[a.guard] ? a.guard : 'standard';
  out.blockedPaths = Array.isArray(mine.blockedPaths) ? mine.blockedPaths : a.blockedPaths || [];
  out.maintainer = typeof mine.maintainer === 'boolean' ? mine.maintainer : !!a.maintainer;
  out.commands = Array.isArray(mine.commands) ? mine.commands : a.commands || [];
  out.tools = Array.isArray(mine.tools) ? mine.tools : Array.isArray(a.tools) ? a.tools : null;
  out.color = typeof mine.color === 'string' ? mine.color : a.color || '';
  return out;
}

/** What the assistant focuses on, in words for its prompt ('' for none). */
function roleFocus(a) {
  if (a.role === 'custom') return String(a.roleText || '').trim() ? `Your speciality, in the user's words: ${String(a.roleText).trim()}` : '';
  return (ROLES[a.role] || ROLES.none).focus;
}

/** Deny rules for an assistant's tools and guardrails, for its brain and its background worker. */
function denyRules(a) {
  const out = toolsOff(a).flatMap((t) => TOOLS[t].deny);
  out.push(...((GUARDS[a.guard] || {}).deny || []));
  for (const p of a.blockedPaths || []) out.push(`Read(/${p}/**)`, `Edit(/${p}/**)`);
  return [...new Set(out)];
}

/** The tool ids switched off for an assistant. */
function toolsOff(a) {
  return Array.isArray(a.tools) ? Object.keys(TOOLS).filter((t) => !a.tools.includes(t)) : [];
}

/** Every assistant: the built-in five, then the user's own. */
function allAssistants(cfg) {
  return [...IDS, ...Object.keys(customOf(cfg)).filter((id) => !ASSISTANTS[id])].map((id) => ({ id, custom: !ASSISTANTS[id], ...assistantOf(id, cfg) }));
}

/** "friday", "Friday", "my coder" → its id, matching the name the user says. */
function findByName(name, cfg) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const hit = allAssistants(cfg).find((a) => a.name.toLowerCase() === n || (a.settings.wakeWords || []).includes(n));
  return hit ? hit.id : '';
}

/** A short, unused id for a new assistant: "Coach" → "coach", then "coach-2". */
function newId(name, cfg) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'assistant';
  let id = base;
  for (let i = 2; exists(id, cfg); i++) id = `${base}-${i}`;
  return id;
}

module.exports = { ASSISTANTS, IDS, SCOPED, ROLES, TOOLS, GUARDS, PROFILE, roleFocus, toolsOff, denyRules, assistantOf, allAssistants, findByName, newId, exists };
