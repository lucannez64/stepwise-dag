import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request
import urllib.error


class ServerTests(unittest.TestCase):
    def test_read_write_origin_and_exports(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);plan=path/'plan.json';state=path/'state.json'
            plan.write_text(json.dumps({'title':'Test','nodes':[{'id':'A','title':'</script><script>alert(1)</script>','deps':[]}]}))
            process=subprocess.Popen([sys.executable,'-m','stepwise','--plan',str(plan),'--state',str(state),'serve','--port','0'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                url=process.stdout.readline().strip().split()[-1]
                data=json.load(urllib.request.urlopen(url+'/api/state',timeout=5))
                self.assertEqual(data['nodes'][0]['kind'],'ready')
                self.assertIn(b'STEPWISE',urllib.request.urlopen(url,timeout=5).read())
                def post(token,origin):
                    req=urllib.request.Request(url+'/api/step',data=json.dumps({'action':'done','id':'A','msg':'gate green'}).encode(),headers={'Content-Type':'application/json','X-Stepwise-Token':token,'Origin':origin})
                    return urllib.request.urlopen(req,timeout=5)
                for token,origin in [('',url),(data['token'],'https://untrusted.example')]:
                    with self.assertRaises(urllib.error.HTTPError) as e:post(token,origin)
                    self.assertEqual(e.exception.code,403)
                    e.exception.close()
                with post(data['token'],url) as r:self.assertEqual(r.status,200)
                after=json.load(urllib.request.urlopen(url+'/api/state',timeout=5));self.assertEqual(after['nodes'][0]['kind'],'done')
                output=path/'snapshot.html'
                subprocess.run([sys.executable,'-m','stepwise','--plan',str(plan),'--state',str(state),'export',str(output)],check=True,capture_output=True)
                html=output.read_text();self.assertNotIn('</script><script>alert',html);self.assertIn('window.SNAPSHOT=',html);self.assertNotIn('src="/app.js"',html)
                self.assertGreater(html.index('window.SNAPSHOT='),html.index('id="viewport"'))
            finally:
                process.terminate();process.communicate(timeout=5)
