import concurrent.futures
import json
from pathlib import Path
import tempfile
import unittest
from stepwise.core import normalize, derive, import_progress
from stepwise.store import update, read


def example():
    return normalize({'nodes': [{'id':'A','deps':[]},{'id':'B','deps':['A']},{'id':'C','deps':['A']},{'id':'D','deps':['B','C']}]})


class GraphTests(unittest.TestCase):
    def test_diamond_and_stable_order(self):
        p=example(); d=derive(p)
        self.assertEqual(d['order'], ['A','B','C','D'])
        self.assertEqual([n['level'] for n in d['nodes']], [0,1,1,2])
        self.assertEqual(derive(dict(p,nodes=list(reversed(p['nodes']))))['order'],d['order'])
        self.assertEqual(len(d['longest_chain']),3)

    def test_invalid_graphs(self):
        for nodes in [[{'id':'A'},{'id':'A'}],[{'id':'A','deps':['missing']}],[{'id':'A','deps':['B']},{'id':'B','deps':['A']}],[{'id':'A','deps':['A']}],[{'id':'A','deps':['B','B']},{'id':'B'}]]:
            with self.subTest(nodes=nodes),self.assertRaises(ValueError):normalize({'nodes':nodes})

    def test_both_formats(self):
        v=normalize({'nodes':[{'id':'V','done':'proof rejects a mutation'}]})
        self.assertEqual(v['nodes'][0]['exit_check'],'proof rejects a mutation')
        k={'nodes':[{'id':'K','desc':'description','status':'done','commit':'abc','log':[{'time':'t','who':'agent','text':'gate green'}]}]}
        self.assertEqual(normalize(k)['nodes'][0]['description'],'description')
        self.assertEqual(import_progress(k)['steps']['K']['commit'],'abc')
        self.assertEqual(import_progress(k)['log'][0]['msg'],'gate green')

    def test_untrusted_text_is_preserved_as_data(self):
        text='</script><script>alert(1)</script>'
        p=normalize({'nodes':[{'id':'X','title':text}]})
        self.assertEqual(p['nodes'][0]['title'],text)


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json';self.plan=example()
    def tearDown(self):self.tmp.cleanup()

    def test_gate_reset_and_retry(self):
        with self.assertRaisesRegex(ValueError,'unfinished'):update(self.path,self.plan,'start','B')
        update(self.path,self.plan,'done','A')
        update(self.path,self.plan,'start','B')
        update(self.path,self.plan,'done','B',commit='abc')
        update(self.path,self.plan,'reset','A')
        b=next(n for n in derive(self.plan,read(self.path)['steps'])['nodes'] if n['id']=='B')
        self.assertTrue(b['inconsistent'])
        update(self.path,self.plan,'retry','B',force=True)
        b=read(self.path)['steps']['B'];self.assertNotIn('finished',b);self.assertNotIn('commit',b);self.assertEqual(b['retries'],1)

    def test_concurrent_logs_are_not_lost(self):
        def write(i):update(self.path,self.plan,'log','A',str(i))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(write,range(80)))
        entries=read(self.path)['log'];self.assertEqual(len(entries),80);self.assertEqual(len({e['msg'] for e in entries}),80)

    def test_rejected_update_does_not_change_state(self):
        update(self.path,self.plan,'start','A');before=self.path.read_bytes()
        with self.assertRaises(ValueError):update(self.path,self.plan,'done','D')
        self.assertEqual(before,self.path.read_bytes())


if __name__=='__main__':unittest.main()
