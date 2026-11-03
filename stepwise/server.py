"""Loopback dashboard with read-only git facts and authenticated local writes."""
import json
import secrets
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from .core import normalize, derive
from .store import read, update


def git(repo, *args):
    try:
        p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, timeout=3)
        return p.stdout.strip() if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def snapshot(plan_path, state_path, repo=None):
    plan = normalize(json.loads(plan_path.read_text()))
    state = read(state_path)
    data = dict(title=plan['title'], **derive(plan, state['steps']), log=state['log'][-200:][::-1])
    if repo:
        upstream = git(repo, 'rev-parse', '--abbrev-ref', '@{u}')
        data['repo'] = dict(origin=git(repo, 'rev-parse', '--short', '@{u}'), dirty=bool(git(repo, 'status', '--porcelain')), worktrees=max(0,len((git(repo, 'worktree', 'list') or '').splitlines())-1), branch=git(repo, 'branch', '--show-current'), head=git(repo, 'rev-parse', '--short', 'HEAD'),
                            upstream=upstream, ahead=git(repo, 'rev-list', '--count', '@{u}..HEAD') if upstream else None,
                            freshness='Local tracking refs; no fetch performed')
        for n in data['nodes']:
            c = n['progress'].get('commit', '')
            # Resolve to a full commit before using user-supplied text in ancestry checks.
            full = git(repo, 'rev-parse', '--verify', '--end-of-options', c + '^{commit}') if c else None
            n['pushed'] = None
            if full and upstream:
                ancestry = git(repo, 'merge-base', '--is-ancestor', full, '@{u}')
                n['pushed'] = ancestry is not None
    return data


def serve(plan_path, state_path, port, repo=None):
    token = secrets.token_urlsafe(32)
    web = Path(__file__).parent / 'web'

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body, kind='application/json'):
            if isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            host = self.headers.get('Host', '')
            return host in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def do_GET(self):
            if not self.allowed():
                return self.send(403, '{}')
            route = urlparse(self.path).path
            try:
                if route == '/api/state':
                    data = snapshot(plan_path, state_path, repo)
                    data['token'] = token
                    return self.send(200, json.dumps(data))
                file = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}.get(route)
                if not file:
                    return self.send(404, '{}')
                kind = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8'}[file.split('.')[-1]]
                self.send(200, (web / file).read_bytes(), kind)
            except (ValueError, OSError, KeyError) as exc:
                self.send(400, json.dumps({'error': str(exc)}))

        def do_POST(self):
            origin = self.headers.get('Origin')
            allowed_origins = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
            if not self.allowed() or (origin and origin not in allowed_origins) or self.headers.get('X-Stepwise-Token') != token:
                return self.send(403, '{}')
            if self.path != '/api/step':
                return self.send(404, '{}')
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise ValueError('invalid request size')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or any(not isinstance(body.get(k, ''), str) for k in ('action', 'id', 'msg', 'who', 'commit')):
                    raise ValueError('expected string fields')
                plan = normalize(json.loads(plan_path.read_text()))
                update(state_path, plan, body['action'], body['id'], body.get('msg', ''), body.get('who', 'dashboard'), body.get('commit', ''))
                self.send(200, '{}')
            except (ValueError, OSError, KeyError, TypeError) as exc:
                self.send(400, json.dumps({'error': str(exc)}))

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Stepwise: http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()
