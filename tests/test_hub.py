import json
import subprocess
import sys
import unittest

from stepwise import hub


def vela_raw():
    plan = {
        "areas": {"B": "Baseline", "T": "Trusted base"},
        "critical_path": ["A", "C"],
        "nodes": [
            {"id": "A", "area": "B", "size": "S", "hard": False, "title": "First", "done": "gate green", "deps": [], "level": 0, "step": 1},
            {"id": "B", "area": "T", "size": "M", "hard": True, "title": "Second", "done": "", "deps": ["A"], "level": 1, "step": 3},
            {"id": "C", "area": "T", "size": "L", "hard": False, "title": "Third", "done": "", "deps": ["A"], "level": 1, "step": 2},
        ],
    }
    state = {"steps": {"A": {"state": "done", "commit": "abc123", "started": "2026-11-03T10:00:00+01:00"},
                       "C": {"state": "in_progress", "retries": 2, "who": "claude"}},
             "log": [{"t": "2026-11-03T11:00:00+01:00", "step": "C", "kind": "start", "msg": "go", "who": "claude"},
                     {"t": "2026-11-03T10:00:00+01:00", "step": "A", "kind": "done", "msg": "ok"}]}
    return {"plan": plan, "state": state}


def kush_raw():
    return {"plan": {"title": "Kush plan", "nodes": [
        {"id": "X", "area": "core", "title": "X", "size": "M", "hard": False, "deps": [], "status": "done", "desc": "d", "commit": "f00", "log": [
            {"time": "2026-11-04 09:00:00", "who": "agent", "text": "done"}]},
        {"id": "Y", "area": None, "title": "Y", "size": "S", "hard": False, "deps": ["X"], "status": "todo", "desc": "", "commit": None, "log": []},
        {"id": "Z", "area": "core", "title": "Z", "size": "S", "hard": False, "deps": ["Y"], "status": "in_progress", "desc": "", "commit": None, "log": [
            {"time": "2026-11-04 10:00:00", "who": "agent", "text": "started"}]},
    ]}}


class NormalizeTests(unittest.TestCase):
    def test_vela(self):
        d = hub.derive(hub.normalize("vela", vela_raw()), {"pushed": {"abc123": False}})
        by = {n["id"]: n for n in d["nodes"]}
        self.assertEqual(by["A"]["status"], "done")
        self.assertTrue(by["A"]["unpushed"])
        self.assertEqual(by["B"]["status"], "ready")
        self.assertEqual(by["C"]["status"], "progress")
        self.assertEqual(by["A"]["check"], "gate green")
        self.assertEqual(d["order"], ["A", "C", "B"])  # the plan's own step numbers win
        self.assertEqual(d["critical"], ["A", "C"])
        self.assertNotIn("critical_computed", d)
        self.assertEqual(d["counts"]["retries"], 2)
        self.assertEqual([e["step"] for e in d["log"]], ["A", "C"])  # oldest first
        self.assertEqual(by["A"]["users"], ["B", "C"])

    def test_kush(self):
        d = hub.derive(hub.normalize("kush", kush_raw()), None)
        by = {n["id"]: n for n in d["nodes"]}
        self.assertEqual([by[i]["status"] for i in "XYZ"], ["done", "ready", "progress"])
        self.assertEqual(d["order"], ["X", "Y", "Z"])
        self.assertEqual(d["critical"], ["X", "Y", "Z"])
        self.assertTrue(d["critical_computed"])
        self.assertEqual(by["Y"]["area"], "")
        self.assertIn("", d["areas"])
        self.assertEqual(d["progress"]["X"]["commit"], "f00")
        self.assertTrue(d["log"][0]["t"].startswith("2026-11-04T09:00:00"))

    def test_problems_do_not_crash(self):
        raw = {"plan": {"nodes": [{"id": "A", "deps": ["B"]}, {"id": "B", "deps": ["A"]}, {"id": "C", "deps": ["nope"]}]}, "state": {}}
        d = hub.derive(hub.normalize("stepwise", raw), None)
        self.assertTrue(any("cycle" in p for p in d["problems"]))
        self.assertTrue(any("unknown nope" in p for p in d["problems"]))
        self.assertEqual(len(d["order"]), 3)


class LaunchTests(unittest.TestCase):
    def test_remote_launcher_passes_arguments_literally(self):
        req = json.dumps({"cli": [sys.executable, "-c", "import sys, json; print(json.dumps(sys.argv[1:]))"],
                          "args": ["log", "$(touch /tmp/x)", "; rm -rf ~", "~/keep"], "env": {"A": "1"}})
        out = subprocess.run([sys.executable, "-I", "-c", hub.LAUNCH, req], capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), ["log", "$(touch /tmp/x)", "; rm -rf ~", "~/keep"])

    def test_write_rejects_bad_requests(self):
        p = hub.Project({"id": "k", "format": "kush", "plan": "x", "cli": ["true"]}, ".")
        p.snapshot = {"nodes": [{"id": "A"}]}
        for action, sid in (("block", "A"), ("start", "NOPE"), ("log", "A")):
            with self.subTest(action=action), self.assertRaises(ValueError):
                p.write(action, sid, "")

    def test_ids_are_checked(self):
        with self.assertRaises(SystemExit):
            hub.Project({"id": "../x", "plan": "p"}, ".")


if __name__ == "__main__":
    unittest.main()
