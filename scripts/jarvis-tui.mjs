// The jarvis chat in a terminal: an input box with a status line under it, a spinner while JARVIS
// works, replies as they stream, and live updates from the background jobs (what each one is doing,
// when it finishes, what it found), plus what is said to JARVIS by voice or comes from a reminder.
// scripts/jarvis.mjs runs it when stdin and stdout are a terminal.
import net from 'net';

const ESC = '\x1b[';
const c256 = (n) => (s) => `${ESC}38;5;${n}m${s}${ESC}39m`;
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const green = c256(78), red = c256(203), amber = c256(214), cyan = c256(80);
const AGENT_COLOR = { jarvis: 39, friday: 213, karen: 220, edith: 203, vision: 141 };
const SPIN = ['✻', '✶', '✳', '✢', '·', '✢', '✳', '✶'];
const VERBS = ['Thinking', 'Working', 'Considering', 'Looking into it'];
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Wraps text to width, keeping **bold** and `code` across lines; first and rest are line prefixes. */
function wrap(text, width, first, rest) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '', len = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = word.replace(/\*\*|`/g, '').length;
      if (len && len + 1 + w > width) { out.push(line); line = word; len = w; } else { line += (len ? ' ' : '') + word; len += (len ? 1 : 0) + w; }
    }
    out.push(line);
  }
  let b = false, code = false;
  return out.map((l, i) => {
    let s = '';
    for (const part of l.split(/(\*\*|`)/)) {
      if (part === '**') b = !b;
      else if (part === '`') code = !code;
      else s += code ? cyan(part) : b ? bold(part) : part;
    }
    return (i ? rest : first) + s;
  });
}

const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();

export async function runTui({ SOCK, call, op, manage, OPS, MANAGE }) {
  const out = process.stdout, inp = process.stdin;
  let info = (await call({ op: 'info' })) || {};
  const s = {
    buf: '', cur: 0, hist: [], hi: 0, busy: null, boxRow: -1, block: null, verbose: true, armedExit: 0, note: '', spin: 0, closed: false,
  };
  const W = () => Math.max(30, out.columns || 80);
  const color = () => c256(AGENT_COLOR[info.id] || 39);
  const write = (x) => out.write(x);

  // ---------- the box: rule with the agent's name, the input, a rule, the status line ----------
  function statusLine() {
    const ctx = info.context && info.context.tokens ? ` · ctx ${(info.context.tokens / 1000).toFixed(1)}k` : '';
    const jobs = info.jobs && info.jobs.length ? ` · ${amber(`${info.jobs.length} job${info.jobs.length > 1 ? 's' : ''}`)}` : '';
    const left = `  ${color()('●')} ${info.brain || ''} · mic ${info.mic || '?'} · HUD ${info.hud ? 'open' : 'closed'}${ctx}${jobs}${s.verbose ? '' : ' · quiet'}`;
    const hint = s.note || (s.busy ? 'esc to stop' : '/help · ctrl-d to leave');
    const gap = W() - strip(left).length - hint.length - 2;
    return gap > 1 ? left + ' '.repeat(gap) + dim(hint) : left;
  }
  function drawBox() {
    if (s.closed) return;
    const w = W(), cap = w - 2, name = ` ${info.agent || 'JARVIS'} `;
    const rows = Math.max(1, Math.ceil((s.buf.length + 1) / cap));
    const lines = [dim('─'.repeat(Math.max(0, w - name.length - 2))) + color()(bold(name)) + dim('──')];
    for (let r = 0; r < rows; r++) lines.push((r ? '  ' : color()('❯ ')) + s.buf.slice(r * cap, (r + 1) * cap));
    lines.push(dim('─'.repeat(w)), statusLine());
    write(lines.join('\n'));
    const row = Math.floor(s.cur / cap), col = 2 + (s.cur % cap);
    const up = lines.length - 1 - (1 + row);
    if (up) write(`${ESC}${up}A`);
    write(`\r${ESC}${col + 1}G`);
    s.boxRow = 1 + row;
  }
  function clearBox() {
    if (s.boxRow < 0) return;
    if (s.boxRow) write(`${ESC}${s.boxRow}A`);
    write(`\r${ESC}J`);
    s.boxRow = -1;
  }

  // ---------- while JARVIS works: a spinner line at the bottom ----------
  function spinnerLine() {
    const b = s.busy;
    const t = b.tool ? dim(` · ${b.tool}`) : '';
    return `${color()(SPIN[s.spin % SPIN.length])} ${color()(`${b.verb}…`)} ${dim(`(${ago(Date.now() - b.t0)} · esc to stop)`)}${t}`;
  }
  const drawSpin = () => { write(`\r${ESC}K` + spinnerLine().slice(0, W() * 3)); };
  const clearSpin = () => write(`\r${ESC}K`);
  function bottom() { if (s.busy) drawSpin(); else drawBox(); }
  function hide() { if (s.busy) clearSpin(); else clearBox(); }

  /** Lines above the box or the spinner. Ends the reply block in progress, so it isn't redrawn. */
  function print(lines) {
    hide();
    s.block = null;
    write([].concat(lines).join('\n') + '\n');
    bottom();
  }

  /** A reply streaming in: redrawn as a block while it fits on the screen, then only appended. */
  function addReply(text) {
    const w = W(), max = (out.rows || 24) - 3;
    clearSpin();
    if (!s.block) s.block = { text: '', rows: 0, head: !s.busy || !s.busy.replied, frozen: false, shown: 0 };
    const b = s.block;
    if (s.busy) s.busy.replied = true;
    b.text += (b.text ? ' ' : '') + text;
    const lines = wrap(b.text, w - 2, b.head ? color()('● ') : '  ', '  ');
    if (!b.frozen && lines.length <= max) {
      if (b.rows) write(`${ESC}${b.rows}A\r${ESC}J`);
      write(lines.join('\n') + '\n');
      b.rows = lines.length;
    } else {
      b.frozen = true;
      const more = wrap(text, w - 2, '  ', '  ');
      write(more.join('\n') + '\n');
    }
    bottom();
  }

  const refresh = async () => { const r = await call({ op: 'info' }); if (r && r.ok) { info = r; if (!s.busy) { clearBox(); drawBox(); } } };

  // ---------- updates from outside this chat's own turns ----------
  const watch = net.connect(SOCK);
  watch.on('error', () => {});
  watch.on('connect', () => watch.write(JSON.stringify({ op: 'watch' }) + '\n'));
  let wbuf = '';
  watch.on('data', (d) => {
    wbuf += d;
    let i;
    while ((i = wbuf.indexOf('\n')) >= 0) {
      let ev = {};
      try { ev = JSON.parse(wbuf.slice(0, i)); } catch {}
      wbuf = wbuf.slice(i + 1);
      onFeed(ev);
    }
  });
  watch.on('close', () => { if (!s.closed) print(red('  JARVIS stopped. Run jarvis again to start it.')); });
  function onFeed(ev) {
    const w = W() - 4;
    if (ev.t === 'job') {
      const mark = ev.state === 'running' ? amber('✻ Working on') : ev.state === 'completed' ? green('✔ Finished') : ev.state === 'failed' ? red('✘ Failed') : dim('■ Stopped');
      print(`${mark} ${ev.text}`);
      refresh();
    } else if (ev.t === 'progress') print(wrap(ev.text, w, `  ${amber('⎿')} `, '    '));
    else if (ev.t === 'step' && s.verbose) {
      // The job's name only when several are running, to say which one the step belongs to.
      const head = (info.jobs || []).length > 1 ? `${ev.job}: ` : '';
      print(dim(`  ⎿ ${head}${String(ev.text)}`.slice(0, w + 2)));
    }
    else if (ev.t === 'said') {
      const lines = [];
      if (ev.you && ev.via === 'voice') lines.push(dim(`› (voice) ${ev.you}`));
      else if (ev.you && ev.via === 'telegram') lines.push(dim(`› (telegram) ${ev.you}`));
      else if (ev.you && ev.via === 'text') lines.push(dim(`› (HUD) ${ev.you}`));
      lines.push(...wrap(ev.text, W() - 2, color()('● '), '  '));
      print(lines);
      refresh();
    }
  }

  // ---------- a turn ----------
  function ask(text) {
    const c = net.connect(SOCK);
    s.busy = { t0: Date.now(), verb: VERBS[Math.floor(Math.random() * VERBS.length)], tool: '', c, replied: false };
    s.block = null;
    write('\n');
    drawSpin();
    const timer = setInterval(() => { s.spin++; drawSpin(); }, 120);
    let buf = '', done = false;
    c.on('error', () => {});
    c.on('connect', () => c.write(JSON.stringify({ op: 'say', text }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let ev = {};
        try { ev = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        if (ev.t === 'reply') addReply(ev.text);
        else if (ev.t === 'tool') { s.busy.tool = String(ev.text).slice(0, 60); print(dim(`  ⎿ ${ev.text}`)); }
        else if (ev.t === 'done') {
          done = true;
          if (ev.error) print(wrap(ev.text, W() - 2, red('● '), '  ').map((l) => red(l)));
          else if (ev.text) addReply(ev.text);
          else if (ev.cancelled) print(dim('  ⎿ stopped'));
        }
      }
    });
    c.on('close', () => {
      clearInterval(timer);
      const took = ago(Date.now() - s.busy.t0);
      clearSpin();
      s.busy = null;
      s.block = null;
      write((done ? dim(`✻ Worked for ${took} · done ${clock()}`) : dim('  ⎿ stopped')) + '\n\n');
      drawBox();
      refresh();
    });
  }

  // ---------- slash commands: their output goes above the box ----------
  async function slash(t) {
    const [cmd, ...rest] = t.slice(1).match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"(.*)"$/, '$1'));
    if (cmd === 'help') return print(dim([
      '  /hud /listen /mute /stop /new /status          the HUD, the mic, this conversation',
      '  /agents  /agent <name>                         list the agents, switch to one',
      '  /devices  /device <name>  /pair [code]  /unpair <name>',
      '  /verbose                                       show or hide each step a job takes',
      '  /clear  /quit (quits JARVIS)  /exit or ctrl-d (leaves this chat)',
      '  esc or ctrl-c stops an answer',
    ].join('\n')));
    if (cmd === 'verbose') { s.verbose = !s.verbose; return print(dim(`  Job steps ${s.verbose ? 'shown' : 'hidden'}.`)); }
    if (cmd === 'clear') { clearBox(); write(`${ESC}2J${ESC}H`); return drawBox(); }
    const lines = [];
    const log = console.log, err = console.error;
    console.log = console.error = (...a) => lines.push(a.join(' '));
    try {
      if (OPS.includes(cmd)) await op(cmd);
      else if (MANAGE.includes(cmd)) await manage([cmd, ...rest]);
      else lines.push(`Unknown command /${cmd}. /help lists them.`);
    } finally { console.log = log; console.error = err; }
    if (lines.length) print([...lines.map((l) => '  ' + l), '']);
    if (cmd === 'quit') return leave();
    refresh();
  }

  // ---------- keys ----------
  function edit(fn) { clearBox(); fn(); drawBox(); }
  function submit() {
    const t = s.buf.trim();
    clearBox();
    s.buf = ''; s.cur = 0;
    if (!t) return drawBox();
    s.hist.push(t); s.hi = s.hist.length;
    write(dim('› ') + t + '\n');
    if (t === '/exit' || t === 'exit') return leave();
    if (t.startsWith('/')) { drawBox(); slash(t); return; }
    ask(t);
  }
  function leave() {
    if (s.closed) return;
    clearBox();
    s.closed = true;
    write(`${ESC}?2004l`);
    try { inp.setRawMode(false); } catch {}
    watch.destroy();
    inp.pause();
    process.exit(0);
  }
  function key(k) {
    if (k === '\x03' || k === '\x1b') {                          // ctrl-c, esc
      if (s.busy) { s.busy.c.destroy(); return; }
      if (k === '\x1b') return;
      if (s.buf) return edit(() => { s.buf = ''; s.cur = 0; });
      if (Date.now() - s.armedExit < 2000) return leave();
      s.armedExit = Date.now();
      s.note = 'ctrl-c again to leave';
      edit(() => {});
      setTimeout(() => { s.note = ''; if (!s.busy) edit(() => {}); }, 2000);
      return;
    }
    if (k === '\x04') { if (!s.buf && !s.busy) leave(); return; }
    if (s.busy) {                                                // typed ahead: kept for after the answer
      if (k === '\r') return;
      if (k === '\x7f') s.buf = s.buf.slice(0, -1); else if (k >= ' ') s.buf += k;
      s.cur = s.buf.length;
      return;
    }
    const ins = (txt) => { s.buf = s.buf.slice(0, s.cur) + txt + s.buf.slice(s.cur); s.cur += txt.length; };
    switch (k) {
      case '\r': return submit();
      case '\x7f': case '\b': return edit(() => { if (s.cur) { s.buf = s.buf.slice(0, s.cur - 1) + s.buf.slice(s.cur); s.cur--; } });
      case `${ESC}3~`: return edit(() => { s.buf = s.buf.slice(0, s.cur) + s.buf.slice(s.cur + 1); });
      case `${ESC}D`: return edit(() => { s.cur = Math.max(0, s.cur - 1); });
      case `${ESC}C`: return edit(() => { s.cur = Math.min(s.buf.length, s.cur + 1); });
      case `${ESC}H`: case '\x01': case `${ESC}1~`: return edit(() => { s.cur = 0; });
      case `${ESC}F`: case '\x05': case `${ESC}4~`: return edit(() => { s.cur = s.buf.length; });
      case '\x15': return edit(() => { s.buf = s.buf.slice(s.cur); s.cur = 0; });
      case '\x0b': return edit(() => { s.buf = s.buf.slice(0, s.cur); });
      case '\x17': return edit(() => { const a = s.buf.slice(0, s.cur).replace(/\S+\s*$/, ''); s.buf = a + s.buf.slice(s.cur); s.cur = a.length; });
      case `${ESC}A`: return edit(() => { if (s.hi > 0) { s.hi--; s.buf = s.hist[s.hi]; s.cur = s.buf.length; } });
      case `${ESC}B`: return edit(() => { if (s.hi < s.hist.length) { s.hi++; s.buf = s.hist[s.hi] || ''; s.cur = s.buf.length; } });
      case '\x1bb': return edit(() => { s.cur = s.buf.slice(0, s.cur).replace(/\S+\s*$/, '').length; });
      case '\x1bf': return edit(() => { const m = s.buf.slice(s.cur).match(/^\s*\S+/); s.cur += m ? m[0].length : 0; });
    }
    if (k.startsWith(ESC) || k.startsWith('\x1b')) return;          // other keys
    edit(() => ins(k.replace(/[\x00-\x1f]/g, '')));
  }
  // A chunk of input: escape sequences, pasted text (bracketed paste) and plain keys.
  function onData(d) {
    let x = String(d);
    while (x) {
      if (x.startsWith(`${ESC}200~`)) {
        const end = x.indexOf(`${ESC}201~`);
        const text = (end < 0 ? x.slice(6) : x.slice(6, end)).replace(/\r\n|\r|\n/g, ' ').replace(/[\x00-\x1f]/g, '');
        if (s.busy) { s.buf += text; s.cur = s.buf.length; } else edit(() => { s.buf = s.buf.slice(0, s.cur) + text + s.buf.slice(s.cur); s.cur += text.length; });
        x = end < 0 ? '' : x.slice(end + 6);
        continue;
      }
      const m = x.match(/^\x1b\[[0-9;]*[A-Za-z~]|^\x1b[bf]|^\x1b(?!\[)|^[\s\S]/);
      key(m[0]);
      x = x.slice(m[0].length);
    }
  }

  // ---------- start ----------
  const w = Math.min(W(), 68);
  const pad = (t) => `${dim('│')} ${t}${' '.repeat(Math.max(0, w - 4 - strip(t).length))} ${dim('│')}`;
  write([
    dim('╭' + '─'.repeat(w - 2) + '╮'),
    pad(`${color()('✻')} ${bold(String(info.agent || 'JARVIS').split('').join('.'))}`),
    pad(dim(`${info.brain || ''} · mic ${info.mic || '?'}`)),
    pad(dim('Type to talk. /help for commands. Jobs report here live.')),
    dim('╰' + '─'.repeat(w - 2) + '╯'),
    '', '',
  ].join('\n'));
  write(`${ESC}?2004h`);
  inp.setRawMode(true);
  inp.resume();
  inp.on('data', onData);
  out.on('resize', () => { if (!s.busy) { clearBox(); drawBox(); } });
  process.on('exit', () => { try { out.write(`${ESC}?2004l`); inp.setRawMode(false); } catch {} });
  drawBox();
  await new Promise(() => {});
}
