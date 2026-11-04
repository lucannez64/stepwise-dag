"""One dashboard for several dependency plans, wherever they live.

Each project keeps its own files and its own CLI. The hub reads them on the
machine that holds them (locally, or over SSH with a shared connection) and
sends dashboard actions through the project's own CLI, so agents working in
that project see the same state they always did.

Config (default ~/.config/stepwise/hub.json):

    {"projects": [
      {"id": "vela", "title": "VELA formalization", "format": "vela",
       "plan": "~/VELA/security/assurance/formalization-plan.json",
       "state": "~/.cache/vela-plan/formalization-status.json",
       "repo": "~/VELA", "cli": ["python3", "-I", "~/VELA/security/assurance/plan-live.py"],
       "box": "me@buildbox", "direction": "LR"},
      {"id": "kush", "title": "Kush", "format": "kush", "host": "me@laptop",
       "plan": "~/kush/plan/plan.json", "repo": "~/kush",
       "cli": ["python3", "~/kush/scripts/plan.py"], "direction": "TB"},
      {"id": "demo", "format": "stepwise", "plan": "examples/plan.json",
       "state": ".stepwise/state.json"}
    ]}

`host` is an SSH destination; leave it out for this machine. `env` adds
environment variables to CLI writes. `box` is a second machine whose load is
shown next to the project's own.
"""
import base64
import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
PROBE = (HERE / "probe.py").read_text()
# Unix sockets have a ~108 byte path limit, so prefer the short runtime dir.
SSH_DIR = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp") / f"stepwise-{os.getuid()}"
MAX_MSG = 2000
LOG_KEEP = 5000

# Actions each format's own CLI understands, and how to spell them.
FORMATS = {
    "vela": {"start": "start", "done": "done", "block": "block", "retry": "retry", "log": "log", "reset": "undo"},
    "kush": {"start": "start", "done": "done", "reset": "todo", "log": "log"},
    "stepwise": {"start": "start", "done": "done", "block": "block", "retry": "retry", "log": "log", "reset": "reset"},
}

# Runs a CLI on the remote side without a shell: expands ~ in the CLI words
# only, then execs. The whole request travels as one quoted JSON argument.
LAUNCH = ("import json,os,subprocess,sys;c=json.loads(sys.argv[1]);"
          "a=[os.path.expanduser(x) for x in c['cli']]+c['args'];"
          "e=dict(os.environ,**c['env']);"
          "p=subprocess.run(a,env=e,capture_output=True,text=True,timeout=60);"
          "sys.stdout.write(p.stdout);sys.stderr.write(p.stderr);sys.exit(p.returncode)")


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def ssh_opts():
    SSH_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Keepalives make a shared connection notice a dead network within ~10 s.
    return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
            "-o", "ControlMaster=auto", "-o", f"ControlPath={SSH_DIR}/%C", "-o", "ControlPersist=600"]


def ssh_cmd(host, remote):
    return ["ssh", *ssh_opts(), host, remote]


def drop_connection(host):
    """Close the shared SSH connection so the next call opens a fresh one."""
    try:
        subprocess.run(["ssh", *ssh_opts(), "-O", "exit", host], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass
    # A frozen connection ignores "exit"; removing its socket makes the next call start fresh.
    try:
        out = subprocess.run(["ssh", *ssh_opts(), "-G", host], capture_output=True, text=True, timeout=5).stdout
        path = next((line.split(None, 1)[1] for line in out.splitlines() if line.startswith("controlpath ")), None)
        if path and Path(path).parent == SSH_DIR:
            Path(path).unlink(missing_ok=True)
    except (OSError, subprocess.SubprocessError, StopIteration):
        pass


def run(host, argv, stdin=None, timeout=20, env=None):
    """Run argv locally or on host. Returns (code, stdout, stderr)."""
    if host:
        argv = ssh_cmd(host, " ".join(shlex.quote(a) for a in argv))
        env = None
    try:
        p = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, **env) if env else None)
        code, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        code, out, err = 124, "", f"no answer after {timeout}s"
    except OSError as exc:
        code, out, err = 127, "", str(exc)
    if host and code in (124, 255):
        # 255 is ssh's own failure; a timeout may mean a dead shared connection.
        drop_connection(host)
        reason = (err.strip().splitlines() or ["connection failed"])[-1]
        err = f"cannot reach {host}: {reason}"
    return code, out, err


# ------------------------------------------------------------ normalizing ----
def kush_time(s):
    try:
        return dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return s or ""


def normalize(fmt, raw):
    """Turn one format's plan and progress into the shared shape."""
    plan, state = raw["plan"], raw.get("state") or {}
    nodes, progress, log, areas = [], {}, [], {}
    for n in plan.get("nodes", []):
        node = {
            "id": str(n["id"]), "title": str(n.get("title") or n["id"]),
            "area": str(n.get("area") or ""), "size": str(n.get("size") or ""),
            "hard": bool(n.get("hard")), "deps": [str(d) for d in n.get("deps") or []],
            "check": str((n.get("done") if fmt == "vela" else n.get("exit_check")) or ""),
            "desc": str(n.get("desc") or n.get("description") or ""),
        }
        for k in ("level", "step"):
            if isinstance(n.get(k), int):
                node[k] = n[k]
        nodes.append(node)
        if fmt == "kush":
            entries = [e for e in n.get("log") or [] if isinstance(e, dict)]
            for e in entries:
                log.append({"t": kush_time(e.get("time")), "step": node["id"], "kind": "",
                            "who": str(e.get("who") or ""), "msg": str(e.get("text") or "")})
            status = n.get("status") or "todo"
            if status != "todo" or n.get("commit"):
                last = entries[-1] if entries else {}
                progress[node["id"]] = {
                    "state": status, "commit": n.get("commit") or "",
                    "updated": kush_time(last.get("time")) if last else "",
                    "who": str(last.get("who") or ""), "note": str(last.get("text") or ""),
                    "retries": int(n.get("retries") or 0),
                }
    if fmt == "kush":
        for n in nodes:
            areas.setdefault(n["area"], n["area"] or "other")
    else:
        areas = {str(k): str(v) for k, v in (plan.get("areas") or {}).items()}
        for n in nodes:
            areas.setdefault(n["area"], n["area"] or "other")
        for sid, e in (state.get("steps") or {}).items():
            if isinstance(e, dict):
                progress[str(sid)] = {k: e.get(k) for k in
                                      ("state", "started", "finished", "updated", "who", "retries", "note", "commit")}
        for e in state.get("log") or []:
            if isinstance(e, dict):
                log.append({"t": str(e.get("t") or ""), "step": str(e.get("step") or ""),
                            "kind": str(e.get("kind") or ""), "who": str(e.get("who") or ""),
                            "msg": str(e.get("msg") or "")})
    log.sort(key=lambda e: e["t"])
    title = plan.get("title")
    return {"nodes": nodes, "progress": progress, "log": log[-LOG_KEEP:], "areas": areas,
            "critical": [str(x) for x in plan.get("critical_path") or []], "plan_title": title}


def derive(data, repo):
    """Status, order, level, critical path and counts, computed once on the server."""
    nodes = data["nodes"]
    by = {n["id"]: n for n in nodes}
    problems = []
    for n in nodes:
        bad = [d for d in n["deps"] if d not in by]
        if bad:
            problems.append(f"{n['id']} needs unknown {', '.join(bad)}")
            n["deps"] = [d for d in n["deps"] if d in by]
        n["users"] = []
    for n in nodes:
        for d in n["deps"]:
            by[d]["users"].append(n["id"])

    depth, visiting = {}, set()

    def node_depth(i):
        if i in depth:
            return depth[i]
        if i in visiting:
            raise ValueError(f"dependency cycle through {i}")
        visiting.add(i)
        deps = by[i]["deps"]
        depth[i] = 1 + max(map(node_depth, deps)) if deps else 0
        visiting.discard(i)
        return depth[i]

    try:
        for n in nodes:
            node_depth(n["id"])
    except (ValueError, RecursionError) as exc:
        problems.append(str(exc))
        for n in nodes:
            depth.setdefault(n["id"], 0)

    progress = data["progress"]
    pushed = (repo or {}).get("pushed") or {}

    def state(n):
        return (progress.get(n["id"]) or {}).get("state")

    done = {n["id"] for n in nodes if state(n) == "done"}
    for n in nodes:
        s = state(n)
        n["status"] = ("done" if s == "done" else "progress" if s == "in_progress" else
                       "blocked" if s == "blocked" else
                       "ready" if all(d in done for d in n["deps"]) else "waiting")
        commit = (progress.get(n["id"]) or {}).get("commit") or ""
        n["unpushed"] = n["status"] == "done" and pushed.get(commit) is False
        n["unmet"] = [d for d in n["deps"] if d not in done]
        if "level" not in n:
            n["level"] = depth[n["id"]]

    if all("step" in n for n in nodes):
        order = [n["id"] for n in sorted(nodes, key=lambda n: n["step"])]
    else:
        # Kahn's algorithm: finished work first, then shallow, then file order.
        pos = {n["id"]: i for i, n in enumerate(nodes)}
        remaining = {n["id"]: set(n["deps"]) for n in nodes}
        order = []
        while remaining:
            free = [i for i, d in remaining.items() if not d] or [min(remaining, key=pos.get)]
            pick = min(free, key=lambda i: (i not in done, depth[i], pos[i]))
            order.append(pick)
            del remaining[pick]
            for d in remaining.values():
                d.discard(pick)
    for i, sid in enumerate(order, 1):
        by[sid]["order"] = i

    critical = [c for c in data["critical"] if c in by]
    if not critical and nodes and not problems:
        # Longest chain of steps (not of time), ending anywhere.
        best = {}
        for sid in order:
            n = by[sid]
            prev = max((best[d] for d in n["deps"]), key=len, default=[])
            best[sid] = prev + [sid]
        critical = max(best.values(), key=len)
        data["critical_computed"] = True
    data["critical"] = critical

    counts = {k: 0 for k in ("done", "progress", "blocked", "ready", "waiting")}
    for n in nodes:
        counts[n["status"]] += 1
    counts["unpushed"] = sum(n["unpushed"] for n in nodes)
    counts["total"] = len(nodes)
    counts["retries"] = sum(int((progress.get(n["id"]) or {}).get("retries") or 0) for n in nodes)
    data["counts"] = counts
    data["order"] = order
    data["problems"] = problems
    return data


# ---------------------------------------------------------------- sources ----
class Project:
    def __init__(self, cfg, base):
        self.cfg = cfg
        self.id = cfg["id"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", self.id):
            raise SystemExit(f"project id {self.id!r}: use lowercase letters, digits, - and _")
        self.fmt = cfg.get("format", "stepwise")
        if self.fmt not in FORMATS:
            raise SystemExit(f"{self.id}: unknown format {self.fmt}")
        self.host = cfg.get("host") or None
        if self.fmt == "stepwise" and self.host:
            raise SystemExit(f"{self.id}: stepwise-format projects must be local")
        self.title = cfg.get("title") or self.id
        self.base = base
        self.interval = float(cfg.get("interval", 4 if self.host else 3))
        self.snapshot = None
        self.error = None
        self.fetched = 0.0
        self.lock = threading.Lock()
        self.reloading = threading.Lock()  # one probe at a time, so an older read never wins
        self.wake = threading.Event()

    def path(self, key):
        p = self.cfg.get(key)
        if not p or self.host:
            return p
        p = os.path.expanduser(p)
        return p if os.path.isabs(p) else str((self.base / p).resolve())

    def probe(self):
        req = json.dumps({"plan": self.path("plan"), "state": self.path("state"), "repo": self.path("repo")})
        code, out, err = run(self.host, ["python3", "-I", "-", req], stdin=PROBE, timeout=15)
        if code != 0:
            raise RuntimeError((err or out or f"exit {code}").strip().splitlines()[-1][:300])
        raw = json.loads(out)
        if raw.get("error"):
            raise RuntimeError(raw["error"])
        if self.fmt == "stepwise" and raw.get("state") is None:
            raw["state"] = {"steps": {}, "log": []}
        data = derive(normalize(self.fmt, raw), raw.get("repo"))
        data.update(
            id=self.id, title=self.title, format=self.fmt, host=self.host or "this machine",
            machine=raw.get("hostname"), load=raw.get("load"), repo=raw.get("repo"),
            mtime=raw.get("mtime"), actions=list(FORMATS[self.fmt]),
            log_starts=self.fmt == "vela",  # VELA's CLI starts a step when you log on it
            direction=self.cfg.get("direction", "TB"), edges=self.cfg.get("edges", "all"),
            box_host=self.cfg.get("box"),
        )
        return data

    def refresh(self):
        with self.reloading:
            self._refresh()

    def _refresh(self):
        try:
            data = self.probe()
            with self.lock:
                self.snapshot, self.error, self.fetched = data, None, time.time()
        except Exception as exc:  # keep serving the last good snapshot
            with self.lock:
                self.error = str(exc) or exc.__class__.__name__

    def loop(self):
        while True:
            self.refresh()
            self.wake.wait(self.interval)
            self.wake.clear()

    def view(self, boxes):
        with self.lock:
            snap, err, fetched = self.snapshot, self.error, self.fetched
        if snap is None:
            return {"id": self.id, "title": self.title, "format": self.fmt,
                    "host": self.host or "this machine", "error": err or "loading", "loading": err is None}
        out = dict(snap)
        out["error"] = err
        out["age"] = round(time.time() - fetched, 1)
        out["box"] = boxes.get(out["box_host"]) if out.get("box_host") else None
        return out

    def summary(self, boxes):
        v = self.view(boxes)
        if "nodes" not in v:
            return v
        progress = v["progress"]
        active = [{"id": n["id"], "title": n["title"], "status": n["status"],
                   "started": (progress.get(n["id"]) or {}).get("started"),
                   "updated": (progress.get(n["id"]) or {}).get("updated")}
                  for n in v["nodes"] if n["status"] in ("progress", "blocked")]
        ready = [n for n in v["nodes"] if n["status"] == "ready"]
        ready.sort(key=lambda n: n["order"])
        return {k: v.get(k) for k in ("id", "title", "format", "host", "machine", "counts", "repo",
                                      "load", "box", "box_host", "error", "age", "problems")} | {
            "active": active,
            "ready": [{"id": n["id"], "title": n["title"]} for n in ready[:6]],
            "log": v["log"][-8:],
        }

    def write(self, action, sid, msg):
        cli = self.cfg.get("cli")
        if action not in FORMATS[self.fmt]:
            raise ValueError(f"{self.fmt} plans do not support {action}")
        snap = self.snapshot
        if not snap or sid not in {n["id"] for n in snap["nodes"]}:
            raise ValueError(f"unknown step {sid}")
        msg = " ".join(str(msg or "").split())[:MAX_MSG]
        msg = re.sub(r"^-+", lambda m: "–" * len(m.group()), msg)  # never looks like an option
        if action == "log" and not msg:
            raise ValueError("a log entry needs a message")
        if self.fmt == "stepwise":
            from .core import normalize as plan_normalize
            from .store import update
            plan = plan_normalize(json.loads(Path(self.path("plan")).read_text()))
            update(self.path("state"), plan, FORMATS["stepwise"][action], sid, msg, "dashboard")
        else:
            if not cli:
                raise ValueError("this project has no cli configured, so it is read-only")
            args = [FORMATS[self.fmt][action], sid]
            if msg and action != "reset":
                args.append(msg)
            args += ["--who", "dashboard"]
            env = {str(k): str(v) for k, v in (self.cfg.get("env") or {}).items()}
            if self.host:
                req = json.dumps({"cli": cli, "args": args, "env": env})
                code, out, err = run(self.host, ["python3", "-I", "-c", LAUNCH, req], timeout=60)
            else:
                code, out, err = run(None, [os.path.expanduser(c) for c in cli] + args, timeout=60, env=env)
            if code != 0:
                raise ValueError((err or out or f"exit {code}").strip().splitlines()[-1][:300])
        self.refresh()


class Boxes(dict):
    """Load averages of build boxes, refreshed in the background."""

    def __init__(self, hosts):
        super().__init__()
        self.hosts = sorted(set(hosts))
        if self.hosts:
            threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            for h in self.hosts:
                code, out, _ = run(h, ["sh", "-c", "cat /proc/loadavg; nproc"], timeout=10)
                parts = out.split()
                try:
                    self[h] = [float(x) for x in parts[:3]] + [int(parts[5])] if code == 0 else None
                except (ValueError, IndexError):
                    self[h] = None
            time.sleep(20)


# ----------------------------------------------------------------- server ----
def page(static=None):
    html = (WEB / "index.html").read_text()
    if static is None:
        return html
    css = (WEB / "style.css").read_text()
    js = (WEB / "app.js").read_text()
    blob = json.dumps(static).replace("</", "<\\/")
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>{css}</style>")
    icon = "data:image/svg+xml;base64," + base64.b64encode((WEB / "favicon.svg").read_bytes()).decode()
    html = html.replace('href="favicon.svg"', f'href="{icon}"')
    return html.replace('<script src="app.js"></script>',
                        f"<script>window.STEPWISE_STATIC={blob};</script><script>{js}</script>")


def load_projects(cfg, base):
    projects = [Project(p, Path(base)) for p in cfg.get("projects", [])]
    if not projects:
        raise SystemExit("no projects configured")
    if len({p.id for p in projects}) != len(projects):
        raise SystemExit("project ids must be unique")
    return projects


def export(cfg, base, project_id, output):
    """Write an offline snapshot of one project."""
    p = next((p for p in load_projects(cfg, base) if p.id == project_id), None)
    if p is None:
        raise SystemExit(f"no project {project_id}")
    p.refresh()
    snap = p.view({})
    if "nodes" not in snap:
        raise SystemExit(f"{project_id}: {snap.get('error')}")
    Path(output).write_text(page(dict(snap, exported=now_iso())))


def serve(cfg, base, port, hosts, names=()):
    projects = load_projects(cfg, base)
    by = {p.id: p for p in projects}
    boxes = Boxes(p.cfg["box"] for p in projects if p.cfg.get("box"))
    for p in projects:
        threading.Thread(target=p.loop, daemon=True).start()
    allowed_hosts = set()
    files = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg"}
    kinds = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
             "css": "text/css; charset=utf-8", "svg": "image/svg+xml"}

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body, kind="application/json", extra=None):
            b = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(b)

        def host_ok(self):
            # Refuse other Host names, so a web page cannot rebind its DNS to us.
            return self.headers.get("Host", "") in allowed_hosts

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, '{"error":"forbidden host"}')
            route = unquote(urlparse(self.path).path)
            if route == "/api/projects":
                return self.send(200, json.dumps({"projects": [p.summary(boxes) for p in projects],
                                                  "now": now_iso()}))
            m = re.fullmatch(r"/api/project/([a-z0-9_-]+)", route)
            if m and m.group(1) in by:
                return self.send(200, json.dumps(by[m.group(1)].view(boxes)))
            m = re.fullmatch(r"/export/([a-z0-9_-]+)\.html", route)
            if m and m.group(1) in by:
                snap = by[m.group(1)].view(boxes)
                if "nodes" not in snap:
                    return self.send(503, '{"error":"not loaded yet"}')
                snap = dict(snap, exported=now_iso())
                return self.send(200, page(snap), kinds["html"], {
                    "Content-Disposition": f'attachment; filename="{m.group(1)}-plan.html"'})
            if route in files:
                name = files[route]
                return self.send(200, (WEB / name).read_bytes(), kinds[name.rsplit(".", 1)[1]])
            self.send(404, '{"error":"not found"}')

        def do_POST(self):
            origin = self.headers.get("Origin", "")
            host = self.headers.get("Host", "")
            if not self.host_ok() or (origin and origin not in (f"http://{host}", f"https://{host}")) \
                    or self.headers.get("X-Stepwise") != "1":
                return self.send(403, '{"error":"forbidden"}')
            m = re.fullmatch(r"/api/project/([a-z0-9_-]+)/step", urlparse(self.path).path)
            if not m or m.group(1) not in by:
                return self.send(404, '{"error":"not found"}')
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8192:
                    raise ValueError("bad request size")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or not all(isinstance(body.get(k, ""), str) for k in ("action", "id", "msg")):
                    raise ValueError("expected action, id and msg strings")
                p = by[m.group(1)]
                p.write(body.get("action", ""), body.get("id", ""), body.get("msg", ""))
                self.send(200, json.dumps(p.view(boxes)))
            except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
                self.send(400, json.dumps({"error": str(exc)}))

        def log_message(self, *_):
            pass

    servers = [ThreadingHTTPServer((hosts[0], port), Handler)]
    port = servers[0].server_port  # port 0 picks a free one
    servers += [ThreadingHTTPServer((h, port), Handler) for h in hosts[1:]]
    allowed_hosts.update({f"{h}:{port}" for h in [*hosts, *names]} | {f"localhost:{port}", f"127.0.0.1:{port}"})
    for h in hosts:
        print(f"Stepwise ({len(projects)} project{'s' * (len(projects) > 1)}): http://{h}:{port}", flush=True)
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


def tailscale_ip():
    code, out, _ = run(None, ["tailscale", "ip", "-4"], timeout=5)
    return out.split()[0] if code == 0 and out.split() else None


def tailscale_names():
    """This machine's MagicDNS names, so http://<name>:<port> works from a phone."""
    code, out, _ = run(None, ["tailscale", "status", "--json"], timeout=5)
    try:
        dns = json.loads(out)["Self"]["DNSName"].rstrip(".") if code == 0 else ""
    except (ValueError, KeyError, AttributeError):
        return []
    return [dns, dns.split(".")[0]] if dns else []


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="stepwise hub", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="~/.config/stepwise/hub.json")
    ap.add_argument("--port", type=int, default=4320)
    ap.add_argument("--tailscale", action="store_true",
                    help="also listen on this machine's Tailscale address (tailnet devices only, e.g. a phone)")
    ap.add_argument("--host", action="append", default=[], help="extra address to listen on")
    ap.add_argument("--allow-name", action="append", default=[],
                    help="extra host name browsers may use to reach the hub (Tailscale names are added with --tailscale)")
    a = ap.parse_args(argv)
    hosts = ["127.0.0.1"] + a.host
    names = list(a.allow_name)
    if a.tailscale:
        names += tailscale_names()
        ip = tailscale_ip()
        if not ip:
            raise SystemExit("--tailscale: no Tailscale IPv4 address (is tailscaled up?)")
        hosts.append(ip)
    path = Path(a.config).expanduser()
    if not path.exists():
        raise SystemExit(f"{path} not found. Write one: see `python3 -m stepwise hub --help`.")
    serve(json.loads(path.read_text()), path.parent, a.port, list(dict.fromkeys(hosts)), names)


if __name__ == "__main__":
    main(sys.argv[1:])
