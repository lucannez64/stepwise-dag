# Stepwise

Turn a large goal into small, verifiable steps. Keep the dependency graph as the source of truth, explore it in a live dashboard, and report milestones from a CLI that people and agents can both use.

Stepwise combines the planning approaches developed in **Kush** and **VELA**: editable prerequisites and build order, completion checks and graph exploration, locked progress updates, activity logs, and optional repository facts. This is a standalone implementation; it does not install into, update, or control either project.

## Run

Python 3.10+ on Linux or macOS. No runtime dependencies, npm installation, cloud account, or background service required.

```sh
git clone https://github.com/lucannez64/stepwise-dag.git
cd stepwise-dag
python3 -m stepwise --plan examples/plan.json serve
# Open http://127.0.0.1:4320
```

Or `python3 -m pip install .` and use the `stepwise` command. Windows is not currently supported: progress locking uses POSIX `flock`.

The server starts only when you run `serve`, binds to loopback, and stops with Ctrl-C. It uses a different port from the original dashboards.

## Plan and execute

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

## Dashboard

- Graph and numbered build-order views; zoom, pan and fit.
- Search, area and state filters; selection highlights ancestors and descendants.
- Completion checks, prerequisites, work unblocked, risk flags, activity and retry counts.
- Longest dependency chain, explicitly measured in steps rather than time.
- Theme (system/light/dark), density, text size, graph direction, panel width and estimate visibility. Preferences persist in browser storage and never edit the plan.
- Live refresh every three seconds. Updates are milestone reports, not automatic observation of agent work.
- Keyboard-focusable nodes and controls, visible focus indicators, textual state labels and a build-order alternative to the graph.

Optional `serve --repo /path/to/repo` inspects branch, HEAD, upstream and commit ancestry without changing the repository. Push indicators refer to **local tracking refs**, never a fresh query of GitHub; missing refs or commits show unknown. It performs no fetches, SSH calls or host telemetry collection.

```sh
python3 -m stepwise export plan-snapshot.html
```

The exported file includes plan and progress data and works offline. It is read-only; preferences still work. Review its contents before sharing. No project data is included in this repository beyond the neutral example.

## Planning conventions

A plan is a DAG, not a priority ranking or commit history. Edges represent actual prerequisites. Independent nodes can swap positions in a topological ordering. Stepwise uses lexicographic ID tie-breaking for reproducibility, independent of progress state.

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

Local API writes require a per-server token, an allowed Host, and a same-origin Origin when supplied. The dashboard uses DOM text nodes for plan and log content. The server is a local development tool, with no multi-user authentication or public hosting mode. Do not expose it through an unauthenticated proxy.

Graph rendering targets plans of hundreds of nodes. There is no scheduler, automatic gate runner, multi-project database or remote worker. Server changes are made through milestones and CLI plan edits; the graph is not a drag-to-edit canvas. Browser interaction testing is described in `VALIDATION.md`.

MIT licensed. See [ORIGINS.md](ORIGINS.md) for the design lineage.
