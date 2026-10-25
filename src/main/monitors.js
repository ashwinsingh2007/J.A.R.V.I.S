// SystemMonitor: CPU / RAM / disk / battery for the HUD.
// EventInbox: tails ~/.jarvis/events.jsonl, which Claude Code hooks append to
// (scripts/hook-event.sh), for instant news of permission prompts and
// finished turns in other sessions.
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const C = require('./config');
const { run } = require('./util');

class SystemMonitor extends EventEmitter {
  start(interval = 3000) { this.timer = setInterval(() => this.tick(), interval); this.tick(); }

  cpu() {
    const t = os.cpus().reduce((a, c) => {
      for (const k of Object.keys(c.times)) a[k] = (a[k] || 0) + c.times[k];
      return a;
    }, {});
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    const prev = this.last;
    this.last = { idle: t.idle, total };
    if (!prev || total === prev.total) return 0;
    return Math.round((1 - (t.idle - prev.idle) / (total - prev.total)) * 100);
  }

  async tick() {
    const out = { cpu: this.cpu() };
    // Used = active + wired + compressed (Activity Monitor's "Memory Used", roughly).
    const vm = (await run('/usr/bin/vm_stat', [], { timeout: 5000 })).out;
    const page = parseInt((/page size of (\d+)/.exec(vm) || [])[1] || '16384', 10);
    const pages = (k) => parseInt((new RegExp(`${k}:\\s+(\\d+)`).exec(vm) || [])[1] || '0', 10);
    const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
    const total = os.totalmem();
    out.ram = total ? Math.round((used * 100) / total) : 0;
    out.ramUsedGB = Math.round(used / 1e8) / 10;
    out.ramTotalGB = Math.round(total / 1e8) / 10;
    try {
      const s = fs.statfsSync('/');
      out.disk = Math.round((1 - s.bavail / s.blocks) * 100);
      out.diskFreeGB = Math.round((s.bavail * s.bsize) / 1e9);
    } catch {}
    const batt = (await run('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 })).out;
    const m = /(\d+)%/.exec(batt);
    out.battery = m ? parseInt(m[1], 10) : null;
    out.charging = !!m && /charging/.test(batt) && !/discharging/.test(batt);
    const up = os.uptime();
    const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), mi = Math.floor((up % 3600) / 60);
    out.uptime = d ? `${d}d ${h}h` : (h ? `${h}h ${mi}m` : `${mi}m`);
    out.host = os.hostname().replace(/\.local$/, '');
    this.emit('update', out);
  }
}

class EventInbox extends EventEmitter {
  start() {
    try { this.offset = fs.statSync(C.EVENTS_FILE).size; } catch { this.offset = 0; }   // only new events matter
    this.timer = setInterval(() => this.poll(), 1000);
  }

  poll() {
    let size;
    try { size = fs.statSync(C.EVENTS_FILE).size; } catch { return; }
    if (size < this.offset) this.offset = 0;      // truncated
    if (size === this.offset) return;
    const fd = fs.openSync(C.EVENTS_FILE, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    for (const line of buf.toString('utf8').split('\n')) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      this.emit('event', {
        name: o.jarvis_event || '', cwd: o.cwd || '', sessionId: o.session_id || '',
        message: o.message || '', lastAssistant: o.last_assistant_message || '', notificationType: o.notification_type || '',
      });
    }
  }
}

module.exports = { SystemMonitor, EventInbox };
