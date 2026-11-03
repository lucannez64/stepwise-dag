"""Atomic, locked progress writes on POSIX systems."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import tempfile
from .core import derive


def read(path):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else {'steps': {}, 'log': []}


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def update(path, plan, action, sid, msg='', who='', commit='', force=False):
    if action not in ('start', 'done', 'block', 'retry', 'log', 'reset'):
        raise ValueError('unknown action')
    if sid not in {n['id'] for n in plan['nodes']}:
        raise ValueError('unknown node: ' + sid)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read(path)
        node = next(n for n in derive(plan, data['steps'])['nodes'] if n['id'] == sid)
        if action in ('start', 'done', 'retry') and node['unmet'] and not force:
            raise ValueError('unfinished prerequisites: ' + ', '.join(node['unmet']))
        t = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        if action == 'reset':
            data['steps'].pop(sid, None)
        else:
            e = data['steps'].setdefault(sid, {'state': 'todo', 'retries': 0})
            e.update(updated=t)
            if who:
                e['who'] = who
            if msg:
                e['note'] = msg
            if action in ('start', 'retry'):
                if e['state'] != 'in_progress':
                    e['started'] = t
                e['state'] = 'in_progress'
                e.pop('finished', None)
                e.pop('commit', None)
            if action == 'retry':
                e['retries'] = e.get('retries', 0) + 1
            if action == 'block':
                e['state'] = 'blocked'
            if action == 'done':
                e.update(state='done', finished=t, commit=commit)
        data['log'].append(dict(t=t, step=sid, kind=action, msg=msg, who=who, forced=force))
        data['log'] = data['log'][-2000:]
        atomic(path, data)
        return data


def edit_plan(path, action, node):
    from .core import normalize
    path = Path(path)
    with open(str(path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        plan = normalize(json.loads(path.read_text()))
        if action == 'add':
            plan['nodes'].append(node)
        elif action == 'deps':
            existing = next((n for n in plan['nodes'] if n['id'] == node['id']), None)
            if existing is None:
                raise ValueError('unknown node: ' + node['id'])
            existing['deps'] = node['deps']
        else:
            raise ValueError('unknown edit action')
        atomic(path, normalize(plan))
