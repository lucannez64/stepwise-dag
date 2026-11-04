import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request


class ServerTests(unittest.TestCase):
    def test_single_project_serve_writes_and_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            plan, state = path / 'plan.json', path / 'state.json'
            plan.write_text(json.dumps({'title': 'Test', 'nodes': [
                {'id': 'A', 'title': '</script><script>alert(1)</script>', 'deps': []},
                {'id': 'B', 'title': 'Second', 'deps': ['A']}]}))
            cmd = [sys.executable, '-m', 'stepwise', '--plan', str(plan), '--state', str(state)]
            process = subprocess.Popen(cmd + ['serve', '--port', '0'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                url = process.stdout.readline().strip().split()[-1]

                def get(route, host=None):
                    req = urllib.request.Request(url + route, headers={'Host': host} if host else {})
                    return urllib.request.urlopen(req, timeout=10)

                def state_of(step):
                    for _ in range(50):
                        d = json.load(get('/api/project/plan'))
                        if 'nodes' in d:
                            return next(n['status'] for n in d['nodes'] if n['id'] == step)
                        import time
                        time.sleep(0.1)
                    self.fail('project never loaded')

                self.assertEqual(state_of('A'), 'ready')
                self.assertEqual(state_of('B'), 'waiting')
                self.assertIn(b'id="switcher"', get('/').read())
                projects = json.load(get('/api/projects'))['projects']
                self.assertEqual([p['id'] for p in projects], ['plan'])

                with self.assertRaises(urllib.error.HTTPError) as e:
                    get('/api/projects', host='evil.example')
                self.assertEqual(e.exception.code, 403)
                e.exception.close()

                def post(body, headers):
                    req = urllib.request.Request(url + '/api/project/plan/step', data=json.dumps(body).encode(),
                                                 headers={'Content-Type': 'application/json', **headers})
                    return urllib.request.urlopen(req, timeout=10)

                ok = {'action': 'done', 'id': 'A', 'msg': 'gate green'}
                for headers in ({}, {'X-Stepwise': '1', 'Origin': 'https://untrusted.example'}):
                    with self.assertRaises(urllib.error.HTTPError) as e:
                        post(ok, headers)
                    self.assertEqual(e.exception.code, 403)
                    e.exception.close()
                with self.assertRaises(urllib.error.HTTPError) as e:
                    post({'action': 'done', 'id': 'B'}, {'X-Stepwise': '1'})
                self.assertEqual(e.exception.code, 400)  # prerequisite A is not done yet
                e.exception.close()
                with post(ok, {'X-Stepwise': '1', 'Origin': url}) as r:
                    self.assertEqual(r.status, 200)
                self.assertEqual(state_of('A'), 'done')
                self.assertEqual(state_of('B'), 'ready')

                output = path / 'snapshot.html'
                subprocess.run(cmd + ['export', str(output)], check=True, capture_output=True)
                html = output.read_text()
                self.assertNotIn('</script><script>alert', html)
                self.assertIn('window.STEPWISE_STATIC=', html)
                self.assertNotIn('src="app.js"', html)
                self.assertGreater(html.index('window.STEPWISE_STATIC='), html.index('id="switcher"'))
            finally:
                process.terminate()
                process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
