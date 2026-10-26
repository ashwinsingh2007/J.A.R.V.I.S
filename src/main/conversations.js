// The conversations shown in the HUD's right panel: the user's chat with JARVIS, and
// each crew member's jobs (what JARVIS asked, what they reported). Kept in
// ~/.jarvis/conversations.json so they survive a restart.
const fs = require('fs');
const path = require('path');
const C = require('./config');

const FILE = path.join(C.STATE_DIR, 'conversations.json');
const KEEP = 80;
const CREW = ['friday', 'karen', 'edith', 'vision'];
const hhmm = () => new Date().toTimeString().slice(0, 5);

class Conversations {
  constructor() {
    this.chat = [];     // { t, you, jarvis }
    this.jobs = [];     // { id, agent, t, description, task, status, step, result }
    try { Object.assign(this, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
    // Jobs that were running when JARVIS stopped won't report any more.
    for (const j of this.jobs) if (j.status === 'running') j.status = 'stopped';
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { fs.writeFileSync(FILE, JSON.stringify({ chat: this.chat, jobs: this.jobs }), { mode: 0o600 }); } catch {}
    }, 500);
  }

  turn(you, jarvis) {
    if (!you && !jarvis) return;
    this.chat.push({ t: hhmm(), you: String(you || '').slice(0, 2000), jarvis: String(jarvis || '').slice(0, 4000) });
    this.chat = this.chat.slice(-KEEP);
    this.save();
  }

  job(t) {
    let j = this.jobs.find((x) => x.id === t.id);
    if (!j) {
      if (t.status !== 'running') return;
      j = { id: t.id, agent: CREW.includes(t.agent) ? t.agent : 'friday', t: hhmm(), description: t.description || 'a job', task: String(t.task || '').slice(0, 4000), status: 'running', step: '', result: '' };
      this.jobs.push(j);
      this.jobs = this.jobs.slice(-KEEP * 2);
    } else if (t.status) j.status = t.status;
    this.save();
  }

  progress(id, line) {
    const j = this.jobs.find((x) => x.id === id);
    if (j && line) j.step = String(line).slice(0, 200);
  }

  result(r) {
    const j = this.jobs.find((x) => x.id === r.id);
    if (!j) return;
    j.result = String(r.text || '').slice(0, 6000);
    if (j.status === 'running') j.status = r.ok === false ? 'failed' : 'completed';
    this.save();
  }

  running(agent) { return this.jobs.filter((j) => j.agent === agent && j.status === 'running').length; }

  /** Entries for the panel: { t, who, name, text } with who = you | jarvis | crew | working. */
  entries(key) {
    if (key === 'jarvis') {
      const out = [];
      for (const c of this.chat.slice(-30)) {
        if (c.you) out.push({ t: c.t, who: 'you', name: 'YOU', text: c.you });
        if (c.jarvis) out.push({ t: c.t, who: 'jarvis', name: 'JARVIS', text: c.jarvis });
      }
      return out;
    }
    const out = [];
    for (const j of this.jobs.filter((x) => x.agent === key).slice(-15)) {
      out.push({ t: j.t, who: 'jarvis', name: 'JARVIS', text: j.task || j.description });
      if (j.result) out.push({ t: '', who: 'crew', name: key.toUpperCase(), text: j.result });
      else if (j.status === 'running') out.push({ t: '', who: 'working', name: key.toUpperCase(), text: j.step ? `Working: ${j.step}` : `Working on ${j.description}…` });
      else out.push({ t: '', who: 'working', name: key.toUpperCase(), text: `${j.status === 'failed' ? 'Failed' : 'Stopped'} without a report.` });
    }
    return out;
  }
}

module.exports = { Conversations, CREW };
