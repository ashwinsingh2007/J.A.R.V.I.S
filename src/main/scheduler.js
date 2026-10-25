// Reminders and scheduled tasks from schedule.json (written by
// scripts/remind.py and the HUD). Checks every 15 s; a due item fires once,
// then repeats move to their next time and one-offs are removed. Items that
// fell due while JARVIS was closed fire when it starts, marked late.
//
// events: 'due' (item, lateMinutes), 'change' (items)
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const C = require('./config');
const { log } = require('./util');

const FILE = path.join(C.STATE_DIR, 'schedule.json');

function local(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The next time a repeating item is due, strictly after `after`. */
function nextDue(due, repeat, after = new Date()) {
  const d = new Date(due);
  const step = () => {
    if (repeat === 'hourly') d.setHours(d.getHours() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else d.setDate(d.getDate() + 1);
  };
  do {
    step();
    if (repeat === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  } while (d <= after);
  return d;
}

class Scheduler extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.load();
  }

  load() {
    try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); this.items = Array.isArray(d.items) ? d.items : []; } catch { this.items = []; }
  }

  save() {
    fs.mkdirSync(C.STATE_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    this.emit('change', this.items);
  }

  start() {
    let t = null;
    fs.watchFile(FILE, { interval: 1500 }, () => {
      clearTimeout(t);
      t = setTimeout(() => { this.load(); this.emit('change', this.items); }, 200);
    });
    this.timer = setInterval(() => this.tick(), 15000);
    setTimeout(() => this.tick(), 3000);
  }

  tick() {
    const now = new Date();
    let changed = false;
    for (const it of [...this.items]) {
      const due = new Date(it.due);
      if (isNaN(due) || due > now) continue;
      const late = Math.round((now - due) / 60000);
      log(`schedule: due ${it.kind} '${it.text.slice(0, 60)}' (${late} min late)`);
      // A repeat that was missed many times fires once, not once per missed slot.
      if (it.repeat) { it.last = local(now); it.due = local(nextDue(it.due, it.repeat, now)); }
      else this.items = this.items.filter((x) => x !== it);
      changed = true;
      this.emit('due', it, late);
    }
    if (changed) this.save();
  }

  /** Upcoming items, soonest first. */
  upcoming(withinHours = Infinity) {
    const limit = Date.now() + withinHours * 3600000;
    return this.items.filter((i) => new Date(i.due).getTime() <= limit).sort((a, b) => a.due.localeCompare(b.due));
  }

  cancel(id) {
    const n = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== n) this.save();
  }
}

module.exports = { Scheduler, nextDue };
