// The crew for brains other than Claude Code: runs one job for FRIDAY, KAREN,
// EDITH or VISION as its own `claude -p` process on the work model (Opus by
// default), with that member's persona, and reports back. Those brains hand jobs
// over with the `delegate` tool; the Claude Code brain uses its own background
// subagents for the same crew.
//
// Events, in the same shape as the Claude Code brain's background agents, so the
// orchestrator treats both alike:
//   'task'     { id, description, agent, status: 'running' | 'completed' | 'failed' | 'killed' } (+ task when running)
//   'progress' { id, step } or { id, status }   (STATUS: lines the agent writes)
//   'result'   { id, description, agent, text, ok }
const { spawn } = require('child_process');
const EventEmitter = require('events');
const C = require('../config');
const { log, env, jsonLines } = require('../util');
const { CREW, crewName, agentPrompt, claudeSettings, claudeDisallowed } = require('./common');

const MAX_JOBS = 3;
const MAX_MINUTES = 30;

class Worker extends EventEmitter {
  constructor(cfg, claudePath) {
    super();
    this.cfg = cfg;
    this.claudePath = claudePath;
    this.jobs = new Map();       // id -> { proc, description, agent, text, timer }
    this.n = 0;
  }

  get busy() { return this.jobs.size; }

  /** Start a job. Returns a line for the brain: the job id, or why it couldn't start. */
  start(description, task, agent = 'friday') {
    description = String(description || 'a job').slice(0, 80);
    task = String(task || '').trim();
    agent = CREW.includes(agent) ? agent : 'friday';
    const name = crewName(agent);
    if (!task) return 'Error: the task is empty. Write a complete instruction.';
    if (this.jobs.size >= MAX_JOBS) return `Error: the crew is already running ${this.jobs.size} jobs. Wait for one to finish.`;
    const id = `${agent}-${Date.now()}-${++this.n}`;
    const args = [
      '-p', task,
      '--output-format', 'stream-json', '--verbose',
      '--model', this.cfg.agentModel === 'inherit' ? 'opus' : this.cfg.agentModel,
      '--append-system-prompt', agentPrompt(this.cfg, agent),
      '--dangerously-skip-permissions',
      '--chrome',
      '--disallowedTools', claudeDisallowed(this.cfg),
      '--setting-sources', '',
      '--settings', claudeSettings(),
    ];
    let proc;
    try { proc = spawn(this.claudePath, args, { env: env({ JARVIS: '1', JARVIS_WORKER: '1' }), cwd: C.HOME, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log(`${agent}: failed to start: ${e}`); return `Error: ${name} could not start (${e.message}).`; }
    const job = { proc, description, agent, text: '', result: '' };
    job.timer = setTimeout(() => { log(`${agent}: '${description}' ran over ${MAX_MINUTES} min, stopping`); proc.kill('SIGTERM'); }, MAX_MINUTES * 60000);
    this.jobs.set(id, job);
    log(`${agent}: started '${description}' pid ${proc.pid} model=${args[args.indexOf('--model') + 1]}`);
    this.emit('task', { id, description, agent, task, status: 'running' });

    jsonLines(proc.stdout, (obj) => this.handle(id, obj));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s) => { if (s.trim()) log(`${agent} stderr: ${s.slice(0, 200)}`); });
    proc.on('error', (e) => log(`${agent}: ${e}`));
    proc.on('exit', (code) => this.finish(id, code));
    return `Started. ${name} is ${description} and will report back. Job id ${id}.`;
  }

  handle(id, obj) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (obj.type === 'assistant' && !obj.parent_tool_use_id) {
      for (const b of (obj.message && obj.message.content) || []) {
        if (b.type === 'text') {
          job.text = b.text || job.text;
          const m = /(?:^|\n)\s*STATUS:\s*(.+)/.exec(b.text || '');
          if (m) { log(`${job.agent}: status '${m[1].trim().slice(0, 80)}'`); this.emit('progress', { id, status: m[1].trim().slice(0, 160) }); }
        } else if (b.type === 'tool_use') {
          this.emit('progress', { id, step: stepOf(b.name) });
        }
      }
    } else if (obj.type === 'result') {
      job.result = typeof obj.result === 'string' ? obj.result : job.text;
      job.error = !!obj.is_error;
    }
  }

  finish(id, code) {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(id);
    const text = (job.result || job.text || '').trim();
    const ok = code === 0 && !job.error && !!text;
    const status = job.killed ? 'killed' : ok ? 'completed' : 'failed';
    log(`${job.agent}: ${status} '${job.description}' (exit ${code})`);
    this.emit('task', { id, description: job.description, agent: job.agent, status });
    if (!job.killed) this.emit('result', { id, description: job.description, agent: job.agent, text: text || `${crewName(job.agent)} stopped without a report.`, ok });
  }

  stopAll() {
    for (const job of this.jobs.values()) { job.killed = true; job.proc.kill('SIGTERM'); }
  }
}

/** "mcp__claude-in-chrome__navigate" → "navigate in Chrome"; "Bash" → "Bash". */
function stepOf(name) {
  const mcp = /^mcp__([\w-]+?)__(\w+)/.exec(String(name));
  return mcp ? `${mcp[2].replace(/_/g, ' ')}${/chrome/i.test(mcp[1]) ? ' in Chrome' : ''}` : String(name).slice(0, 60);
}

module.exports = { Worker };
