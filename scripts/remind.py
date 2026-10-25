#!/usr/bin/env python3
"""Reminders and scheduled tasks, kept in ~/.jarvis/schedule.json. JARVIS fires them on time.

  remind.py add  --at <when> [--repeat R] "<what to say>"          a reminder, spoken at that time
  remind.py task --at <when> [--repeat R] "<what to do and report>" a job JARVIS does at that time
  remind.py list
  remind.py cancel <id | words>

  <when>: "YYYY-MM-DD HH:MM" (24 h, local time), "HH:MM" (today, or tomorrow if passed), "+20m", "+2h", "+1d"
  R: daily | weekdays | weekly | hourly
"""
import datetime as dt
import json
import os
import re
import secrets
import sys

STATE = os.environ.get('JARVIS_STATE_DIR') or os.path.expanduser('~/.jarvis')
FILE = os.path.join(STATE, 'schedule.json')
REPEATS = ['daily', 'weekdays', 'weekly', 'hourly']


def load():
    try:
        with open(FILE) as f:
            data = json.load(f)
        if isinstance(data.get('items'), list):
            return data
    except Exception:
        pass
    return {'items': []}


def save(data):
    os.makedirs(STATE, exist_ok=True)
    tmp = FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, FILE)


def parse_when(s):
    s = s.strip()
    now = dt.datetime.now().replace(second=0, microsecond=0)
    m = re.fullmatch(r'\+(\d+)\s*([mhd])', s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return now + {'m': dt.timedelta(minutes=n), 'h': dt.timedelta(hours=n), 'd': dt.timedelta(days=n)}[unit]
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', s)
    if m:
        t = now.replace(hour=int(m.group(1)), minute=int(m.group(2)))
        return t if t > now else t + dt.timedelta(days=1)
    return dt.datetime.fromisoformat(s.replace('T', ' '))


def show(it):
    when = dt.datetime.fromisoformat(it['due']).strftime('%a %d %b %H:%M')
    rep = {'daily': ' every day', 'weekdays': ' on weekdays', 'weekly': ' every week', 'hourly': ' every hour'}.get(it.get('repeat') or '', '')
    return f"{it['id']}  {it['kind']}  {when}{rep}  {it['text']}"


def opt(args, name):
    if name in args:
        i = args.index(name)
        val = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
        return val
    return None


def norm(s):
    return re.sub(r'[^a-z0-9 ]', '', s.lower())


def main(argv):
    if not argv:
        print(__doc__.strip())
        return 0
    cmd, args = argv[0], argv[1:]
    data = load()
    if cmd in ('add', 'task'):
        at, repeat = opt(args, '--at'), opt(args, '--repeat')
        text = ' '.join(args).strip()
        if not at or not text:
            print('need --at <when> and the text', file=sys.stderr)
            return 2
        if repeat and repeat not in REPEATS:
            print(f'repeat must be one of {", ".join(REPEATS)}', file=sys.stderr)
            return 2
        try:
            due = parse_when(at)
        except ValueError:
            print(f'cannot read the time "{at}"; use "YYYY-MM-DD HH:MM", "HH:MM" or "+20m"', file=sys.stderr)
            return 2
        it = {'id': 'r' + secrets.token_hex(3), 'kind': 'reminder' if cmd == 'add' else 'task', 'text': text[:1000],
              'due': due.isoformat(timespec='minutes'), 'repeat': repeat,
              'created': dt.datetime.now().isoformat(timespec='minutes')}
        data['items'].append(it)
        save(data)
        print(f'scheduled: {show(it)}')
    elif cmd == 'list':
        items = sorted(data['items'], key=lambda i: i['due'])
        print('\n'.join(show(i) for i in items) or 'nothing scheduled')
    elif cmd == 'cancel':
        q = ' '.join(args)
        w = norm(q).split()
        found = [i for i in data['items'] if i['id'] == q or (w and all(x in norm(i['text']) for x in w))]
        if not found:
            print('no match', file=sys.stderr)
            return 1
        if len(found) > 1:
            print('several match; use the id:\n' + '\n'.join(show(i) for i in found))
            return 1
        data['items'] = [i for i in data['items'] if i['id'] != found[0]['id']]
        save(data)
        print(f'cancelled: {show(found[0])}')
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
