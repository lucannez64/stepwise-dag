"""Plan validation and derived dependency views; no project files are modified."""
import heapq

STATES = {'todo', 'in_progress', 'blocked', 'done'}


def normalize(data):
    if not isinstance(data, dict) or not isinstance(data.get('nodes'), list):
        raise ValueError('plan must contain a nodes array')
    if data.get('version', 1) != 1:
        raise ValueError('unsupported plan version')
    nodes = []
    for raw in data['nodes']:
        if not isinstance(raw, dict):
            raise ValueError('each node must be an object')
        n = dict(raw)
        n.setdefault('deps', [])
        n.setdefault('title', n.get('id', ''))
        n.setdefault('area', '')
        n.setdefault('size', '')
        n.setdefault('hard', False)
        n['description'] = n.get('description', n.get('desc', ''))
        n['exit_check'] = n.get('exit_check', n.get('done', ''))
        if not isinstance(n.get('id'), str) or not n['id'].strip():
            raise ValueError('every node needs a nonempty string id')
        if any(not isinstance(n[k], str) for k in ('title', 'area', 'size', 'description', 'exit_check')):
            raise ValueError(f"{n['id']}: text fields must be strings")
        if not isinstance(n['deps'], list) or any(not isinstance(x, str) for x in n['deps']):
            raise ValueError(f"{n['id']}: deps must be an array of ids")
        if len(set(n['deps'])) != len(n['deps']):
            raise ValueError(f"{n['id']}: duplicate prerequisite")
        nodes.append({k: n[k] for k in ('id', 'title', 'area', 'size', 'hard', 'deps', 'description', 'exit_check')})
    plan = {'version': 1, 'title': str(data.get('title', 'Dependency plan')), 'nodes': nodes}
    derive(plan)
    return plan


def derive(plan, steps=None):
    steps = steps or {}
    by = {n['id']: n for n in plan['nodes']}
    if len(by) != len(plan['nodes']):
        raise ValueError('duplicate node id')
    outgoing = {k: [] for k in by}
    degree = {}
    for n in by.values():
        degree[n['id']] = len(n['deps'])
        for dep in n['deps']:
            if dep not in by:
                raise ValueError(f"{n['id']}: unknown prerequisite {dep}")
            outgoing[dep].append(n['id'])
    ready = [k for k in by if degree[k] == 0]
    heapq.heapify(ready)
    order, levels = [], {}
    while ready:
        k = heapq.heappop(ready)
        order.append(k)
        levels[k] = max((levels[d] + 1 for d in by[k]['deps']), default=0)
        for child in outgoing[k]:
            degree[child] -= 1
            if degree[child] == 0:
                heapq.heappush(ready, child)
    if len(order) != len(by):
        raise ValueError('dependency cycle involving: ' + ', '.join(sorted(k for k in by if degree[k])))
    chain = {}
    for k in order:
        parent = max(by[k]['deps'], key=lambda d: len(chain[d]), default=None)
        chain[k] = (chain[parent] if parent else []) + [k]
    longest = max(chain.values(), key=len, default=[])
    result = []
    for pos, k in enumerate(order, 1):
        n = by[k]
        entry = steps.get(k, {})
        state = entry.get('state', 'todo')
        unmet = [d for d in n['deps'] if steps.get(d, {}).get('state') != 'done']
        kind = ('waiting' if unmet else 'ready') if state == 'todo' else state
        result.append(dict(n, **{'order': pos, 'level': levels[k], 'state': state, 'kind': kind,
                                 'unmet': unmet, 'inconsistent': state in ('done', 'in_progress') and bool(unmet),
                                 'progress': entry, 'unblocks': outgoing[k]}))
    return {'nodes': result, 'order': order, 'longest_chain': longest}


def import_progress(data):
    """Extract Kush's embedded status; VELA status is already separate."""
    steps, log = {}, []
    for n in data['nodes']:
        state = n.get('status', 'todo')
        if state not in STATES:
            raise ValueError(f"{n['id']}: unknown status {state}")
        if state != 'todo':
            steps[n['id']] = {'state': state, 'commit': n.get('commit') or '', 'retries': n.get('retries', 0)}
        for e in n.get('log', []):
            log.append({'step': n['id'], 't': e.get('time', ''), 'who': e.get('who', ''), 'msg': e.get('text', ''), 'kind': 'import'})
    return {'steps': steps, 'log': log}


def validate_progress(state, plan):
    if not isinstance(state, dict) or not isinstance(state.get('steps'), dict) or not isinstance(state.get('log'), list):
        raise ValueError('progress must contain steps object and log array')
    ids = {n['id'] for n in plan['nodes']}
    for sid, entry in state['steps'].items():
        if sid not in ids or not isinstance(entry, dict) or entry.get('state') not in STATES:
            raise ValueError('invalid progress entry: ' + str(sid))
    if any(not isinstance(entry, dict) for entry in state['log']):
        raise ValueError('log entries must be objects')
    return state
