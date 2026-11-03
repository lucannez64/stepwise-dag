# Design lineage

This tool was created from a read-only comparison of two planning workflows owned by lucannez64:

- **Kush** (`lucannez64/kush`): `scripts/plan.py`, `scripts/plan-server.py`, `plan/index.html` and `plan/README.md`. Retained ideas: editable dependency plans, deterministic topological ordering, per-node activity, repository context, and the distinction between readiness and priority.
- **VELA** (`lucannez64/VELA`): the formalization planner, HTML template and live-status tool under `security/assurance/`. Retained ideas: explicit exit checks, risk flags, prerequisite/dependent exploration, longest-chain exploration, separate progress state and concurrent milestone reporting.

The inspected snapshots were copied outside their source projects for analysis. This repository contains a fresh implementation of the shared behavior, not copies of either project's source files, transcripts, live histories, machine addresses or actual plans. Adapters support the observed formats.

The original tools remain independent; nothing here redirects their data or replaces their running servers. Integration with an existing project is an explicit copy/import operation.
