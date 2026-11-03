import argparse
import json
from pathlib import Path
import sys
from .core import normalize, derive, import_progress, validate_progress
from .store import read, atomic, update


def main():
    p = argparse.ArgumentParser(description='Dependency-first plans and live progress')
    p.add_argument('--plan', default='plan.json')
    p.add_argument('--state', default='.stepwise/state.json')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('validate')
    sub.add_parser('list')
    s = sub.add_parser('add')
    s.add_argument('id')
    s.add_argument('title')
    s.add_argument('--deps', default='')
    s.add_argument('--exit-check', default='')
    s.add_argument('--area', default='')
    s.add_argument('--size', default='S')
    s.add_argument('--hard', action='store_true')
    s = sub.add_parser('deps')
    s.add_argument('id')
    s.add_argument('prerequisites', help='comma-separated ids, or empty string')
    s = sub.add_parser('import')
    s.add_argument('source')
    s.add_argument('--source-state', help='optional VELA progress file')
    s = sub.add_parser('serve')
    s.add_argument('--port', type=int, default=4320)
    s.add_argument('--repo', help='optional repository to inspect, read-only')
    s = sub.add_parser('export')
    s.add_argument('output', help='standalone HTML with a snapshot of progress')
    for cmd in ('start', 'done', 'block', 'retry', 'log', 'reset'):
        s = sub.add_parser(cmd)
        s.add_argument('id')
        s.add_argument('message', nargs='?', default='')
        s.add_argument('--who', default='')
        s.add_argument('--commit', default='')
        s.add_argument('--force', action='store_true', help='record despite unfinished prerequisites; discrepancy remains visible')
    a = p.parse_args()
    try:
        if a.command == 'import':
            source = json.loads(Path(a.source).read_text())
            plan = normalize(source)
            if Path(a.plan).exists() or Path(a.state).exists():
                raise ValueError('import destinations already exist; choose new --plan and --state paths')
            state = json.loads(Path(a.source_state).read_text()) if a.source_state else import_progress(source)
            validate_progress(state, plan)
            atomic(a.plan, plan)
            atomic(a.state, state)
            print('Imported a copy; source files unchanged.')
            return
        plan = normalize(json.loads(Path(a.plan).read_text()))
        if a.command in ('add', 'deps'):
            from .store import edit_plan
            if a.command == 'add':
                edit_plan(a.plan, 'add', dict(id=a.id, title=a.title, deps=[d for d in a.deps.split(',') if d], exit_check=a.exit_check, area=a.area, size=a.size, hard=a.hard))
            else:
                edit_plan(a.plan, 'deps', dict(id=a.id, deps=[d for d in a.prerequisites.split(',') if d]))
        elif a.command == 'validate':
            print(f"Valid DAG: {len(plan['nodes'])} nodes")
        elif a.command == 'list':
            for n in derive(plan, read(a.state)['steps'])['nodes']:
                print(f"{n['order']:3} {n['kind']:12} {n['id']:24} {n['title']}" + (' [unfinished prerequisites]' if n['inconsistent'] else ''))
        elif a.command == 'serve':
            from .server import serve
            serve(Path(a.plan).resolve(), Path(a.state).resolve(), a.port, a.repo)
        elif a.command == 'export':
            from .server import snapshot
            web = Path(__file__).parent / 'web'
            data = snapshot(Path(a.plan), Path(a.state))
            payload = json.dumps(data).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
            page = (web / 'index.html').read_text().replace('<link rel="stylesheet" href="/style.css">', '<style>' + (web / 'style.css').read_text() + '</style>')
            page = page.replace('<script src="/app.js" defer></script>', '')
            page = page.replace('</body>', '<script>window.SNAPSHOT=' + payload + ';</script><script>' + (web / 'app.js').read_text() + '</script></body>')
            Path(a.output).write_text(page)
            print(a.output)
        else:
            update(a.state, plan, a.command, a.id, a.message, a.who, a.commit, a.force)
    except (ValueError, OSError, KeyError) as exc:
        p.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
