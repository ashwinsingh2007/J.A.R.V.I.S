// The Claude Code skills an assistant can use, and where more come from.
//
// The brain starts without the user's Claude settings (so their own hooks and CLAUDE.md don't change
// JARVIS), which also hides their skills. Each assistant therefore gets a small plugin of its own,
// ~/.jarvis/assistants/<id>/plugin, made of links to the skills it may use, loaded with --plugin-dir.
//
// Skills come from three places: the user's own (~/.claude/skills), the skills inside installed Claude
// Code plugins, and skills added from GitHub in Settings (~/.jarvis/skills, JARVIS's own). An
// assistant's choice is cfg.assistantSettings[id].skills: a list of skill ids, or none for all of them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./config');
const { log, run, which } = require('./util');

const PERSONAL = path.join(C.HOME, '.claude', 'skills');
const OWN = path.join(C.STATE_DIR, 'skills');
const PLUGINS = path.join(C.HOME, '.claude', 'plugins');

/** name and description from a SKILL.md's frontmatter. */
function frontmatter(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 6000); } catch { return null; }
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const field = (k) => {
    const r = new RegExp(`^${k}:[ \\t]*(\\|[+-]?|>[+-]?)?[ \\t]*(.*)$`, 'm').exec(m[1]);
    if (!r) return '';
    if (!r[1]) return r[2].replace(/^["']|["']$/g, '').trim();
    // A block value: the indented lines that follow.
    const rest = m[1].slice(r.index + r[0].length).split('\n').slice(1);
    const lines = [];
    for (const l of rest) { if (/^\s+\S/.test(l)) lines.push(l.trim()); else if (l.trim()) break; }
    return lines.join(' ');
  };
  return { name: field('name'), description: field('description').slice(0, 300) };
}

function scan(dir, source, plugin = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const d of names) {
    const file = path.join(dir, d, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = frontmatter(file) || {};
    out.push({ id: `${plugin || source}/${d}`, name: fm.name || d, description: fm.description || '', source, plugin, path: path.join(dir, d) });
  }
  return out;
}

/** The user's installed Claude Code plugins: { name, market, path }. */
function installedPlugins() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(PLUGINS, 'installed_plugins.json'), 'utf8')).plugins || {}; } catch {}
  return Object.entries(data).map(([key, list]) => {
    const [name, market] = key.split('@');
    const it = (Array.isArray(list) ? list : [list]).find((x) => x && x.installPath) || {};
    return { name, market, path: it.installPath || '' };
  }).filter((p) => p.path);
}

/** Every skill on this Mac that an assistant can use. */
function catalog() {
  const all = [...scan(PERSONAL, 'personal'), ...scan(OWN, 'jarvis')];
  for (const p of installedPlugins()) all.push(...scan(path.join(p.path, 'skills'), 'plugin', p.name));
  const seen = new Set();
  return all.filter((s) => !seen.has(s.id) && seen.add(s.id));
}

/** The skill ids one assistant may use: its own choice, or every skill. */
function chosen(cfg, id, all = catalog()) {
  const pick = ((cfg.assistantSettings || {})[id] || {}).skills;
  return Array.isArray(pick) ? all.filter((s) => pick.includes(s.id)) : all;
}

/**
 * Build the assistant's plugin: links to its skills, nothing else (no hooks, no commands). Returns the
 * plugin folder for --plugin-dir, or '' when it has no skills.
 */
function pluginFor(cfg, id = cfg.assistant) {
  const skills = chosen(cfg, id);
  const dir = path.join(C.STATE_DIR, 'assistants', id.replace(/[^a-z0-9-]/g, ''), 'plugin');
  try {
    fs.rmSync(path.join(dir, 'skills'), { recursive: true, force: true });
    if (!skills.length) return '';
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `jarvis-${id}`, version: '1.0.0', description: `The skills this assistant may use, chosen in JARVIS Settings.` }, null, 1));
    const used = new Set();
    for (const s of skills) {
      let link = (s.plugin ? `${s.plugin}-` : '') + path.basename(s.path);
      for (let i = 2; used.has(link); i++) link = `${path.basename(s.path)}-${i}`;
      used.add(link);
      fs.symlinkSync(s.path, path.join(dir, 'skills', link));
    }
    return dir;
  } catch (e) {
    log(`skills: couldn't build the plugin for ${id}: ${e.message}`);
    return '';
  }
}

// ---------- getting more ----------

/** Marketplaces the user's Claude Code knows, with their plugins and which are installed. */
function marketplaces() {
  let known = {};
  try { known = JSON.parse(fs.readFileSync(path.join(PLUGINS, 'known_marketplaces.json'), 'utf8')); } catch {}
  const installed = new Set(installedPlugins().map((p) => `${p.name}@${p.market}`));
  return Object.entries(known).map(([name, m]) => {
    let plugins = [];
    try {
      const j = JSON.parse(fs.readFileSync(path.join(m.installLocation || path.join(PLUGINS, 'marketplaces', name), '.claude-plugin', 'marketplace.json'), 'utf8'));
      plugins = (j.plugins || []).map((p) => ({ name: String(p.name), description: String(p.description || '').slice(0, 200), category: p.category || '', installed: installed.has(`${p.name}@${name}`) }));
    } catch {}
    const src = m.source || {};
    return { name, from: src.repo || src.url || src.path || '', plugins };
  });
}

const claude = () => which('claude') || path.join(C.HOME, '.local', 'bin', 'claude');
const tidy = (r) => (r.code === 0 ? '' : (r.err || r.out || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 240));

/** A plugin from a marketplace, installed for the user's Claude Code too (user scope). */
async function install(plugin, market) {
  if (!/^[\w.-]+$/.test(plugin) || !/^[\w.-]+$/.test(market)) return 'That is not a plugin name.';
  log(`skills: installing ${plugin}@${market}`);
  return tidy(await run(claude(), ['plugin', 'install', `${plugin}@${market}`, '--scope', 'user'], { timeout: 240000, cwd: C.HOME }));
}

async function uninstall(plugin, market) {
  if (!/^[\w.-]+$/.test(plugin) || !/^[\w.-]+$/.test(market)) return 'That is not a plugin name.';
  log(`skills: removing ${plugin}@${market}`);
  return tidy(await run(claude(), ['plugin', 'uninstall', `${plugin}@${market}`], { timeout: 120000, cwd: C.HOME }));
}

/** "anthropics/skills" or a git URL. */
async function addMarketplace(source) {
  source = String(source || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(source) && !/^https:\/\/[^\s]+$/.test(source)) return 'Use owner/repo or an https address.';
  log(`skills: adding marketplace ${source}`);
  return tidy(await run(claude(), ['plugin', 'marketplace', 'add', source], { timeout: 180000, cwd: C.HOME }));
}

/**
 * Skills from a GitHub repository, copied into JARVIS's own skills folder. Every folder in the repo
 * that holds a SKILL.md becomes one skill. Returns { added: [names], error }.
 */
async function addFromGitHub(repo) {
  repo = String(repo || '').trim().replace(/\.git$/, '').replace(/\/$/, '');
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)$/.exec(repo);
  if (!m) return { added: [], error: 'Use owner/repo or a github.com address.' };
  const git = which('git');
  if (!git) return { added: [], error: 'git is not installed.' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skill-'));
  try {
    log(`skills: fetching github.com/${m[1]}/${m[2]}`);
    const r = await run(git, ['clone', '--depth', '1', `https://github.com/${m[1]}/${m[2]}.git`, path.join(tmp, 'repo')], { timeout: 120000 });
    if (r.code !== 0) return { added: [], error: tidy(r) || 'The download failed.' };
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (names.some((d) => d.isFile() && d.name === 'SKILL.md')) { found.push(dir); return; }
      for (const d of names) if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') walk(path.join(dir, d.name), depth + 1);
    };
    walk(path.join(tmp, 'repo'), 0);
    if (!found.length) return { added: [], error: 'No SKILL.md in that repository.' };
    fs.mkdirSync(OWN, { recursive: true });
    const added = [];
    for (const dir of found) {
      const name = (dir === path.join(tmp, 'repo') ? m[2] : path.basename(dir)).replace(/[^\w.-]/g, '-');
      const to = path.join(OWN, name);
      if (fs.existsSync(to)) continue;
      fs.cpSync(dir, to, { recursive: true, filter: (src) => !/\/\.git(\/|$)/.test(src) });
      added.push(name);
    }
    log(`skills: added ${added.join(', ') || 'nothing new'} from ${m[1]}/${m[2]}`);
    return { added, error: added.length ? '' : 'Those skills are already here.' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A skill added from GitHub (only those; the user's own and plugin skills are theirs to manage). */
function removeOwn(id) {
  const m = /^jarvis\/([\w.-]+)$/.exec(String(id));
  if (!m) return 'Only skills added here can be removed here.';
  fs.rmSync(path.join(OWN, m[1]), { recursive: true, force: true });
  log(`skills: removed ${m[1]}`);
  return '';
}

module.exports = { catalog, chosen, pluginFor, marketplaces, install, uninstall, addMarketplace, addFromGitHub, removeOwn, frontmatter };
