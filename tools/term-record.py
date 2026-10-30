"""Records a terminal program in a pseudo-terminal as an asciicast (v2), typing keys on a timeline.

  python3 tools/term-record.py <cols> <rows> <timeline.json> <out.cast> <program> [args...]

timeline.json: [[seconds to wait, "keys to type"], ...]. Keys are typed one character at a time,
like a person, except escape sequences and control keys, which go in at once.
"""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

cols, rows, timeline, out = int(sys.argv[1]), int(sys.argv[2]), json.load(open(sys.argv[3])), sys.argv[4]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[5], sys.argv[5:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)
t0 = time.time()
events = []

def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            events.append([round(time.time() - t0, 3), 'o', data.decode('utf-8', 'replace')])
    return True

for wait, keys in timeline:
    if not pump(wait):
        break
    if keys.startswith('\x1b') or len(keys) == 1 and ord(keys) < 32:
        os.write(fd, keys.encode())
        continue
    for ch in keys:
        os.write(fd, ch.encode())
        pump(0.045 if ch != ' ' else 0.07)
pump(1.5)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
with open(out, 'w') as f:
    f.write(json.dumps({'version': 2, 'width': cols, 'height': rows}) + '\n')
    for e in events:
        f.write(json.dumps(e) + '\n')
