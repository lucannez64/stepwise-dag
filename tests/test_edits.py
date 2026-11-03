import json
from pathlib import Path
import tempfile
import unittest
from stepwise.store import edit_plan


class EditTests(unittest.TestCase):
    def test_bad_edit_preserves_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'plan.json';p.write_text(json.dumps({'nodes':[{'id':'A','deps':[]},{'id':'B','deps':['A']}]}));before=p.read_bytes()
            with self.assertRaises(ValueError):edit_plan(p,'deps',{'id':'A','deps':['B']})
            self.assertEqual(p.read_bytes(),before)
            edit_plan(p,'add',{'id':'C','title':'Third step','deps':['B']})
            self.assertEqual(len(json.loads(p.read_text())['nodes']),3)
