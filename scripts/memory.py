#!/usr/bin/env python3
"""What JARVIS knows about the user, kept in ~/.jarvis/memory.json.

Every assistant shares that memory, and each one also has its own
(~/.jarvis/assistants/<id>/memory.json) that only it reads. The brain runs this with
JARVIS_AGENT set to the assistant, and JARVIS_SHARED_MEMORY=0 when it doesn't use
the shared memory: then everything goes to and comes from its own.

  memory.py add "<fact>" [--topic person|preference|project|place|routine|other] [--mine]
        --mine keeps it in this assistant's own memory only
  memory.py list [--topic T]
  memory.py search <words>
  memory.py forget <id | words>      (words must match exactly one fact; add --all to drop every match)
  memory.py day [today|yesterday|YYYY-MM-DD]   what was said that day (the journal)
"""
import datetime as dt
import json
import os
import re
import secrets
import sys

STATE = os.environ.get('JARVIS_STATE_DIR') or os.path.expanduser('~/.jarvis')
SHARED_FILE = os.path.join(STATE, 'memory.json')
AGENT = re.sub(r'[^a-z0-9-]', '', os.environ.get('JARVIS_AGENT', ''))
OWN_FILE = os.path.join(STATE, 'assistants', AGENT, 'memory.json') if AGENT else ''
USES_SHARED = os.environ.get('JARVIS_SHARED_MEMORY', '1') != '0' or not OWN_FILE
FILE = SHARED_FILE if USES_SHARED else OWN_FILE
TOPICS = ['person', 'preference', 'project', 'place', 'routine', 'other']


def load(file=None):
    try:
        with open(file or FILE) as f:
            data = json.load(f)
        if isinstance(data.get('facts'), list):
            return data
    except Exception:
        pass
    return {'facts': []}


def save(data, file=None):
    file = file or FILE
    os.makedirs(os.path.dirname(file), exist_ok=True)
    tmp = file + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, file)


def stores():
    """(label, file) for every memory this assistant reads: the shared one, then its own."""
    out = [('', SHARED_FILE)] if USES_SHARED else []
    if OWN_FILE:
        out.append(('own', OWN_FILE))
    return out


def norm(s):
    return re.sub(r'[^a-z0-9 ]', '', s.lower()).strip()


def show(f, label=''):
    return f"{f['id']}  [{f.get('topic', 'other')}{', ' + label if label else ''}] {f['text']}  (since {f.get('added', '?')[:10]})"


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
    if cmd == 'add':
        topic = opt(args, '--topic', 'other')
        mine = '--mine' in args
        args = [a for a in args if a != '--mine']
        text = ' '.join(args).strip()
        if not text:
            print('nothing to remember', file=sys.stderr)
            return 2
        topic = topic if topic in TOPICS else 'other'
        for label, file in stores():
            for f in load(file)['facts']:
                if norm(f['text']) == norm(text):
                    print(f'already known: {show(f, label)}')
                    return 0
        file = OWN_FILE if mine and OWN_FILE else FILE
        data = load(file)
        f = {'id': 'm' + secrets.token_hex(3), 'text': text[:400], 'topic': topic,
             'added': dt.datetime.now().isoformat(timespec='minutes')}
        data['facts'].append(f)
        save(data, file)
        print(f"remembered: {show(f, 'own' if file == OWN_FILE else '')}")
    elif cmd == 'list':
        topic = opt(args, '--topic')
        out = [show(f, label) for label, file in stores() for f in load(file)['facts'] if not topic or f.get('topic') == topic]
        print('\n'.join(out) or 'nothing remembered yet')
    elif cmd == 'search':
        words = ' '.join(args)
        out = [show(f, label) for label, file in stores() for f in matches(load(file), words)]
        print('\n'.join(out) or 'no match')
    elif cmd == 'forget':
        drop_all = '--all' in args
        words = ' '.join(a for a in args if a != '--all')
        found = [(label, file, f) for label, file in stores() for f in matches(load(file), words)]
        if not found:
            print('no match', file=sys.stderr)
            return 1
        if len(found) > 1 and not drop_all:
            print('several facts match; be more specific or add --all:\n' + '\n'.join(show(f, label) for label, _, f in found))
            return 1
        for _, file, _ in found:
            data = load(file)
            ids = {f['id'] for _, fl, f in found if fl == file}
            data['facts'] = [f for f in data['facts'] if f['id'] not in ids]
            save(data, file)
        print('forgot:\n' + '\n'.join(show(f, label) for label, _, f in found))
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
