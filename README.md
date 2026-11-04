# Stepwise

Turn a large goal into small, checkable steps, and watch every project's plan in one place.

A plan is a dependency graph: each step lists what must be done first and how you know it is done. Stepwise shows that graph live, with what is in progress, what is ready, what is blocked, and what agents have logged.

It started as two separate dashboards, one for the **Kush** compiler and one for the **VELA** formalization. Stepwise is one hub for both. It reads each project where it lives, on this machine or another one over SSH, and keeps each project's own files and CLI as the source of truth.

## One hub for several projects

```sh
git clone https://github.com/lucannez64/stepwise-dag.git
cd stepwise-dag
python3 -m stepwise hub --config examples/hub.json   # try it: http://127.0.0.1:4320
mkdir -p ~/.config/stepwise                          # then list your own projects
$EDITOR ~/.config/stepwise/hub.json                  # (format below)
python3 -m stepwise hub                              # reads ~/.config/stepwise/hub.json
python3 -m stepwise hub --tailscale                # also on your tailnet, e.g. for a phone
```

Python 3.10+ on Linux or macOS. No dependencies, no build step, no database.

Each project in `hub.json` says where its plan is and how to change it:

```json
{"projects": [
  {"id": "vela", "title": "VELA formalization", "format": "vela",
   "plan": "~/VELA/security/assurance/formalization-plan.json",
   "state": "~/.cache/vela-plan/formalization-status.json",
   "repo": "~/VELA", "cli": ["python3", "-I", "~/VELA/security/assurance/plan-live.py"],
   "box": "me@buildbox", "direction": "LR"},
  {"id": "kush", "title": "Kush", "format": "kush", "host": "me@laptop",
   "plan": "~/kush/plan/plan.json", "repo": "~/kush",
   "cli": ["python3", "~/kush/scripts/plan.py"], "edges": "direct"}
]}
```

| Key | Meaning |
| --- | --- |
| `format` | `vela`, `kush`, or `stepwise` (this repo's own plan and state files). |
| `host` | SSH destination that holds the project, or a list of routes to the same machine tried in order (LAN address, then Tailscale name). Leave it out for this machine. The hub keeps one shared SSH connection per route and reconnects after a network drop. |
| `plan`, `state`, `repo` | Paths on that machine. `~` works. `repo` adds branch, ahead count, worktrees and "not pushed" marks. |
| `cli` | The project's own plan CLI. Dashboard buttons run it, so agents and the dashboard write the same file the same way. Leave it out to make the project read-only. |
| `env` | Extra environment variables for the CLI. |
| `box` | A second machine whose load is shown next to the project's own. |
| `direction`, `edges` | Default graph direction (`TB` or `LR`) and highlight mode (`all` or `direct`). Each viewer can change both. |

The hub never edits a plan itself. Reads run a small read-only probe on the project's machine. Writes call the project's CLI with fixed arguments and no shell. Kush's CLI has no block or retry, so those buttons do not show for Kush.

### What you see

- **All projects**: one card per project with progress, what is in progress, what is ready next, git state, machine load, and a merged activity feed. Keys `0`–`9` switch projects.
- **Graph**: steps in dependency layers, top to bottom or left to right. Selecting a step lights what it needs (blue) and what it unblocks (orange), as the whole chain or direct links only. Pan, zoom, pinch, fit, critical path or longest chain, area chips, state filters, search (`/`), tooltips, keyboard focus.
- **Order**: one valid build sequence. It is not a priority ranking.
- **Table**: every field, sortable.
- **Side panel**: the selected step's check, notes, runtime, retries, who, commit and push state, what it needs and unblocks, and buttons to start, finish, block, retry, add a note or reset. With nothing selected: in progress, blocked, ready, and the critical path.
- **Running log**: every milestone, newest first, filtered to the selected step.
- **Offline snapshot**: `export/<id>.html` from the hub, or `stepwise export`. It works from a file. Done marks made there stay in that browser.
- **View settings**: Catppuccin Macchiato or Latte (or system), density, text size, size estimates, legend, panel width. They are stored per browser and never change a plan.

## One project without a config

```sh
python3 -m stepwise --plan examples/plan.json serve   # the hub with one stepwise-format project
```

```sh
cp examples/plan.json plan.json
python3 -m stepwise validate
python3 -m stepwise list
python3 -m stepwise start SPEC "writing acceptance examples" --who alice
python3 -m stepwise done SPEC "examples reviewed" --who alice
python3 -m stepwise log SPEC "evidence: docs/acceptance.md"
python3 -m stepwise block MODEL "waiting on an API decision"
python3 -m stepwise retry MODEL "trying a simpler state model"
python3 -m stepwise done MODEL "gate green" --commit FULL_COMMIT_SHA
python3 -m stepwise reset MODEL
python3 -m stepwise add DOCS "Document the feature" --deps REVIEW --exit-check "Examples run on the reviewed commit"
python3 -m stepwise deps DOCS "UI,TEST"
```

Use `--plan PATH --state PATH` **before** the subcommand to choose a workspace. Progress defaults to `.stepwise/state.json`. Milestones store actor, timestamp, note, retries and an optional commit. No commands, tests, commits, fetches or pushes are run by milestone updates.

Start, retry and done reject unfinished prerequisites. CLI `--force` records an intentional override and leaves any prerequisite conflict visible. Resetting a prerequisite reveals conflicts on affected direct dependents; downstream readiness reflects recorded completion, so inspect these warnings before continuing. A done marker is a report, not independent proof that its exit check passed.

`add` and `deps` validate the entire graph before an atomic write. Unknown IDs, duplicate IDs or edges, and cycles are rejected. Direct editing is also supported: the server reloads and validates the plan on every refresh. CLI writers use locks; direct editors should not edit simultaneously with CLI writes.

## Bring an existing plan

Import into **new destination paths**, leaving original plans and running dashboards untouched:

```sh
python3 -m stepwise --plan imported/kush.json --state imported/kush-state.json import /path/to/kush/plan/plan.json
python3 -m stepwise --plan imported/vela.json --state imported/vela-state.json import /path/to/formalization-plan.json --source-state /path/to/formalization-status.json
python3 -m stepwise --plan imported/kush.json --state imported/kush-state.json serve
```

Kush's `desc`, embedded `status`, `commit` and logs are imported. VELA's `done` becomes `exit_check`; its optional separate status file retains progress. Derived `step`, `level` and critical-path fields are recomputed. Imports are snapshots, not write-through synchronization. Existing destinations are refused. Keep original files as the archive for fields outside the shared schema.

## Planning conventions

A plan is a DAG, not a priority ranking or commit history. Edges represent actual prerequisites. Independent nodes can swap positions in a topological ordering. When a plan has no step numbers of its own, Stepwise puts finished steps first, then shallower ones, then file order, so the list reads naturally. VELA plans keep their own numbering.

Keep each step small enough to produce one reviewable result with an observable exit check. If a milestone takes days, split design, implementation, negative tests and integration into separate nodes, preserving its incoming and outgoing dependencies. Keep suggestions about priority in project notes rather than inventing dependency edges.

The longest chain counts nodes. Estimates such as S/M/L are labels, not numerical durations; Stepwise does not claim a duration-weighted critical path or a completion date.

## Schema

```json
{
  "version": 1,
  "title": "My project",
  "nodes": [{
    "id": "API", "title": "Define the API", "deps": [],
    "area": "Design", "size": "S", "hard": false,
    "description": "Inputs and error cases",
    "exit_check": "One success and one failure example are reviewed"
  }]
}
```

Node IDs must be unique, nonempty strings. Prerequisites must exist. Progress and interface preferences are separate from this definition.

## Development and limits

```sh
python3 -m unittest discover -s tests -v
node --check stepwise/web/app.js
```

Writes need an allowed Host (no DNS rebinding), the `X-Stepwise` header, and a same-origin `Origin` when the browser sends one. Plan and log text is escaped. There are no user accounts: anyone who can reach the port can mark steps. Keep it on loopback or your tailnet, never behind a public proxy.

The graph is drawn for plans of a few hundred steps. There is no scheduler and no automatic gate runner. A done mark is a report, not proof that its check passed.

MIT licensed. See [ORIGINS.md](ORIGINS.md) for the design lineage.
