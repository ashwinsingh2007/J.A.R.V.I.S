#!/usr/bin/env node
// Stand-in for the jarvis-ears sidecar in end-to-end tests. Speaks the same
// JSON-lines protocol. Utterances to "hear" are appended (one JSON object per
// line) to $JARVIS_FAKE_SPEECH; commands received from the app are appended to
// $JARVIS_FAKE_EARS_LOG so tests can assert on mute / suspend / reset.
const fs = require('fs');
const speech = process.env.JARVIS_FAKE_SPEECH;
const cmdLog = process.env.JARVIS_FAKE_EARS_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

out({ type: 'log', msg: 'fake ears started' });
out({ type: 'ready' });
out({ type: 'devices', list: [{ id: 1, name: 'Fake Mic', default: true }, { id: 2, name: 'Fake Headset', default: false }] });

let offset = 0;
setInterval(() => {
  let size;
  try { size = fs.statSync(speech).size; } catch { return; }
  if (size <= offset) return;
  const fd = fs.openSync(speech, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); out({ type: 'text', final: false, ...o }); } catch {}
  }
}, 50);

let pending = '';
process.stdin.on('data', (d) => {
  pending += d;
  let i;
  while ((i = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    if (cmdLog) fs.appendFileSync(cmdLog, line + '\n');
    try {
      const o = JSON.parse(line);
      if (o.cmd === 'devices' || o.cmd === 'set_input') out({ type: 'devices', list: [{ id: 1, name: 'Fake Mic', default: o.id !== 2 }, { id: 2, name: 'Fake Headset', default: o.id === 2 }] });
      if (o.cmd === 'transcribe_file') out({ type: 'file_text', id: o.id, text: 'fake transcript' });
    } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));
