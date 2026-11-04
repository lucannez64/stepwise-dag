"""Read one project's plan, progress and repository facts, and print them as JSON.

The hub runs this file with `python3 -I -` on the machine that holds the
project: locally, or over SSH. It must only use the standard library, and it
never writes anything. Input is one JSON object in argv[1]:

    {"plan": PATH, "state": PATH or null, "repo": PATH or null}

Paths may start with ~. Missing files are reported, not raised.
"""
import json
import os
import subprocess
import sys


def read_json(path):
    if not path:
        return None, None
    path = os.path.expanduser(path)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), os.stat(path).st_mtime
    except FileNotFoundError:
        return None, None
    except (OSError, ValueError) as exc:
        raise SystemExit(json.dumps({"error": f"cannot read {path}: {exc}"}))


def git(repo, *args, stdin=None):
    try:
        p = subprocess.run(["git", "-C", repo, *args], input=stdin, capture_output=True,
                           text=True, timeout=6)
        return p.stdout.strip() if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def repo_facts(repo, commits):
    repo = os.path.expanduser(repo)
    upstream = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if not upstream and git(repo, "rev-parse", "--verify", "--quiet", "origin/main"):
        upstream = "origin/main"
    facts = {
        "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        "head": git(repo, "rev-parse", "--short", "HEAD"),
        "upstream": upstream,
        "origin": git(repo, "rev-parse", "--short", upstream) if upstream else None,
        "ahead": None,
        "dirty": bool(git(repo, "status", "--porcelain", "--untracked-files=no")),
        "worktrees": max(0, len((git(repo, "worktree", "list") or "").splitlines()) - 1),
        "pushed": {},
    }
    if upstream:
        ahead = git(repo, "rev-list", "--count", f"{upstream}..HEAD")
        facts["ahead"] = int(ahead) if ahead and ahead.isdigit() else None
    # Resolve every recorded commit in one call, then list the ones the upstream
    # does not contain in one more call. Everything else resolved is pushed.
    wanted = sorted({c.strip() for c in commits if isinstance(c, str) and c.strip() and not any(ch.isspace() for ch in c.strip())})
    if wanted and upstream:
        out = git(repo, "cat-file", "--batch-check=%(objectname) %(objecttype)",
                  stdin="".join(c + "^{commit}\n" for c in wanted)) or ""
        full = {}
        for short, line in zip(wanted, out.splitlines()):
            parts = line.split()
            if len(parts) == 2 and parts[1] == "commit":
                full[short] = parts[0]
        if full:
            missing = set((git(repo, "rev-list", *sorted(set(full.values())), "^" + upstream, "--") or "").split())
            facts["pushed"] = {short: sha not in missing for short, sha in full.items()}
    return facts


def main():
    cfg = json.loads(sys.argv[1])
    plan, plan_mtime = read_json(cfg["plan"])
    if plan is None:
        print(json.dumps({"error": f"plan not found: {cfg['plan']}"}))
        return
    state, state_mtime = read_json(cfg.get("state"))
    commits = []
    for n in plan.get("nodes", []):
        if isinstance(n, dict) and n.get("commit"):
            commits.append(n["commit"])
    for e in ((state or {}).get("steps") or {}).values():
        if isinstance(e, dict) and e.get("commit"):
            commits.append(e["commit"])
    out = {
        "plan": plan,
        "state": state,
        "mtime": max(m for m in (plan_mtime, state_mtime, 0) if m is not None),
        "load": [round(x, 2) for x in os.getloadavg()] + [os.cpu_count()],
        "hostname": os.uname().nodename,
    }
    if cfg.get("repo"):
        out["repo"] = repo_facts(cfg["repo"], commits)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
