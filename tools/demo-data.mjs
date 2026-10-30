// Demo data built from the real presets, for tools/make-shots.mjs and tools/make-demo.mjs: the Agents
// tab and the nodes around the core show the five assistants as they ship.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/main/assistants.js');
const C = require('../src/main/config.js');

/** The 'assistants' event main.js sends, for a fresh install with `current` in use. */
export function assistantsEvent(current = 'jarvis') {
  const base = Object.fromEntries(A.SCOPED.filter((k) => k !== 'wakeWords').map((k) => [k, C.DEFAULTS[k]]));
  const list = Object.entries(A.ASSISTANTS).map(([id, a]) => ({
    id, name: a.name, tier: a.tier, about: a.about, needs: a.needs, custom: false, persona: a.persona,
    defaultPersona: a.persona, defaultRole: a.role || 'none', role: a.role || 'none', roleText: '', commands: [], tools: null,
    color: '', sharedMemory: true, guard: 'standard', blockedPaths: [], maintainer: !!a.maintainer, defaultMaintainer: !!a.maintainer,
    memory: [], wakeWords: (a.settings || {}).wakeWords || [], changed: false, skills: null, mcp: null,
    settings: { ...base, ...Object.fromEntries(Object.entries(a.settings || {}).filter(([k]) => k in base)) },
  }));
  return {
    type: 'assistants', id: current, list,
    env: { ready: { 'claude-code': true, anthropic: false, gemini: true, ollama: false }, ollamaModels: [], engine: 'kokoro' },
    roles: Object.fromEntries(Object.entries(A.ROLES).map(([k, r]) => [k, r.label])),
    tools: Object.fromEntries(Object.entries(A.TOOLS).map(([k, t]) => [k, { label: t.label, about: t.about }])),
    guards: Object.fromEntries(Object.entries(A.GUARDS).map(([k, g]) => [k, { label: g.label, about: g.about }])),
  };
}
