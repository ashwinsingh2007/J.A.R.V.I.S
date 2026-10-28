#!/usr/bin/env python3
"""JARVIS on the user's other devices (paired in Settings > Devices).

  devices.py list                                   paired devices and how each is reached
  devices.py status <device>                        what it is doing: jobs, CPU, RAM
  devices.py ask <device> "<description>" "<task>"  hand it a task and wait for the result
                                                    (can take minutes: run it from a background job)
  devices.py pair-host                              show a pairing code (prints it; type it on the other device)
  devices.py pair-wait                              wait for the pairing started with pair-host to finish
  devices.py pair-join <code>                       pair with the device showing that code, and wait
  devices.py unpair <device>                        forget a paired device (unpair it on that device too)
  devices.py diag                                   what the peer-to-peer side sees (NAT, links), as JSON
"""
import json
import os
import socket
import sys

STATE = os.environ.get('JARVIS_STATE_DIR') or os.path.expanduser('~/.jarvis')
SOCK = os.path.join(STATE, 'jarvis.sock')


def call(req, timeout):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(SOCK)
    except OSError:
        print('JARVIS is not running on this device.', file=sys.stderr)
        sys.exit(1)
    s.sendall((json.dumps(req) + '\n').encode())
    buf = b''
    while not buf.endswith(b'\n'):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    return json.loads(buf or b'{}')


def main(argv):
    if not argv or argv[0] not in ('list', 'status', 'ask', 'pair-host', 'pair-wait', 'pair-join', 'diag', 'unpair'):
        print(__doc__.strip())
        return 0 if not argv else 2
    cmd = argv[0]
    if cmd == 'list':
        r = call({'op': 'list'}, 10)
        print(f"This device: {r.get('me', '?')}")
        for d in r.get('devices', []):
            print(f"- {d['name']} ({d.get('os') or '?'}): {d['via']}, last seen {d.get('lastSeen') or 'never'}")
        if not r.get('devices'):
            print('No other devices paired. The user pairs them in Settings > Devices.')
        return 0
    if cmd == 'unpair':
        r = call({'op': 'unpair', 'device': argv[1] if len(argv) > 1 else ''}, 10)
        print(r.get('text', 'No answer.'))
        return 0 if r.get('ok') else 1
    if cmd == 'diag':
        print(json.dumps(call({'op': 'diag'}, 10), indent=1))
        return 0
    if cmd == 'pair-host':
        r = call({'op': 'pair-host'}, 30)
        print(r.get('code') or r.get('text', 'No answer.'))
        return 0 if r.get('ok') else 1
    if cmd == 'pair-wait':
        r = call({'op': 'pair-wait'}, 200)
        print(r.get('text', 'No answer.'))
        return 0 if r.get('ok') else 1
    if cmd == 'pair-join':
        if len(argv) < 2:
            print('Give the code the other device shows.', file=sys.stderr)
            return 2
        r = call({'op': 'pair-join', 'code': argv[1]}, 200)
        print(r.get('text', 'No answer.'))
        return 0 if r.get('ok') else 1
    if len(argv) < 2:
        print('Say which device.', file=sys.stderr)
        return 2
    if cmd == 'status':
        r = call({'op': 'status', 'device': argv[1]}, 40)
        if not r.get('ok'):
            print(r.get('text', 'No answer.'))
            return 1
        jobs = r.get('jobs', []) + r.get('peerJobs', [])
        print(f"{r.get('name')} ({r.get('os')}): {r.get('assistant') or 'JARVIS'} is {'busy' if r.get('busy') else 'free'}; "
              f"CPU {r.get('cpu')}%, RAM {r.get('ramUsed')} of {r.get('ramTotal')} GB; "
              f"jobs: {', '.join(jobs) if jobs else 'none'}")
        return 0
    if len(argv) < 4:
        print('ask needs a device, a short description and the task.', file=sys.stderr)
        return 2
    r = call({'op': 'ask', 'device': argv[1], 'description': argv[2], 'task': argv[3]}, 46 * 60)
    print(r.get('text', 'No answer.'))
    return 0 if r.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
