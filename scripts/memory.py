#!/usr/bin/env python3
"""What JARVIS knows about the user, kept in ~/.jarvis/memory.json.

  memory.py add "<fact>" [--topic person|preference|project|place|routine|other] [--for friday|karen|edith|vision]
  memory.py list [--topic T] [--for <crew member>]
  memory.py search <words>
  memory.py forget <id | words>      (words must match exactly one fact; add --all to drop every match)
  memory.py day [today|yesterday|YYYY-MM-DD]   what was said that day (the journal)

A fact with --for belongs to one crew member; the rest are everyone's.
"""
import datetime as dt
import json
import os
import re
import secrets
import sys

STATE = os.environ.get('JARVIS_STATE_DIR') or os.path.expanduser('~/.jarvis')
FILE = os.path.join(STATE, 'memory.json')
TOPICS = ['person', 'preference', 'project', 'place', 'routine', 'other']
CREW = ['friday', 'karen', 'edith', 'vision']


def load():
    try:
        with open(FILE) as f:
            data = json.load(f)
        if isinstance(data.get('facts'), list):
            return data
    except Exception:
        pass
    return {'facts': []}


def save(data):
    os.makedirs(STATE, exist_ok=True)
    tmp = FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, FILE)


def norm(s):
    return re.sub(r'[^a-z0-9 ]', '', s.lower()).strip()


def show(f):
    owner = f" for {f['for'].upper()}" if f.get('for') else ''
    return f"{f['id']}  [{f.get('topic', 'other')}{owner}] {f['text']}  (since {f.get('added', '?')[:10]})"


def matches(data, words):
    w = [x for x in norm(words).split() if x]
    return [f for f in data['facts'] if f['id'] == words or (w and all(x in norm(f['text']) for x in w))]


def opt(args, name, default=None):
    if name in args:
        i = args.index(name)
        val = args[i + 1] if i + 1 < len(args) else default
        del args[i:i + 2]
        return val
    return default


def main(argv):
    if not argv:
        print(__doc__.strip())
        return 0
    cmd, args = argv[0], argv[1:]
    data = load()
    if cmd == 'add':
        topic = opt(args, '--topic', 'other')
        owner = (opt(args, '--for') or '').lower()
        text = ' '.join(args).strip()
        if not text:
            print('nothing to remember', file=sys.stderr)
            return 2
        topic = topic if topic in TOPICS else 'other'
        for f in data['facts']:
            if norm(f['text']) == norm(text):
                print(f'already known: {show(f)}')
                return 0
        f = {'id': 'm' + secrets.token_hex(3), 'text': text[:400], 'topic': topic,
             'added': dt.datetime.now().isoformat(timespec='minutes')}
        if owner in CREW:
            f['for'] = owner
        data['facts'].append(f)
        save(data)
        print(f'remembered: {show(f)}')
    elif cmd == 'list':
        topic = opt(args, '--topic')
        owner = (opt(args, '--for') or '').lower()
        facts = [f for f in data['facts'] if (not topic or f.get('topic') == topic) and (not owner or f.get('for', owner) == owner)]
        print('\n'.join(show(f) for f in facts) or 'nothing remembered yet')
    elif cmd == 'search':
        found = matches(data, ' '.join(args))
        print('\n'.join(show(f) for f in found) or 'no match')
    elif cmd == 'forget':
        drop_all = '--all' in args
        args = [a for a in args if a != '--all']
        found = matches(data, ' '.join(args))
        if not found:
            print('no match', file=sys.stderr)
            return 1
        if len(found) > 1 and not drop_all:
            print('several facts match; be more specific or add --all:\n' + '\n'.join(show(f) for f in found))
            return 1
        ids = {f['id'] for f in found}
        data['facts'] = [f for f in data['facts'] if f['id'] not in ids]
        save(data)
        print('forgot:\n' + '\n'.join(show(f) for f in found))
    elif cmd == 'day':
        which = (args or ['today'])[0]
        day = dt.date.today()
        if which == 'yesterday':
            day -= dt.timedelta(days=1)
        elif which != 'today':
            day = dt.date.fromisoformat(which)
        try:
            with open(os.path.join(STATE, 'journal', f'{day.isoformat()}.md')) as f:
                print(f.read()[-6000:])
        except FileNotFoundError:
            print(f'nothing recorded on {day.isoformat()}')
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
