# Validation

The initial release was checked with:

- Unit tests for diamond graphs, deterministic ordering, cycle and missing-ID rejection, both input formats, and rejected edits preserving the prior plan.
- Progress tests for prerequisite enforcement, reset conflicts, retry metadata cleanup, rejected writes preserving state, and 80 concurrent milestone updates without lost log entries.
- An HTTP integration test starting an isolated server on an ephemeral port: page and state reads, token and cross-origin rejection, a successful milestone write, and offline export with script-closing text escaped.
- JavaScript syntax checking with Node, plus a clean virtual-environment package build, installation and installed CLI invocation.
- Read-only imports of the inspected Kush and VELA plan snapshots, both of which passed graph validation. No original source or status files were written.

The CI workflow repeats the automated tests and package installation on Linux and macOS with Python 3.10 and 3.13. Those hosted runs have not been claimed as passed before they execute.

Automated tests do not establish the semantic correctness of a project's dependency choices or its completion reports. Browser appearance, keyboard navigation, touch gestures and preference persistence require interactive browser checks; these are not claimed as covered by the Python tests.

The compact-workspace revision was rendered against actual Kush and VELA snapshots. Desktop and reply-width layouts rendered without console errors. A render-time control smoke check exercised project switching, node selection, direct/transitive highlighting, the order panel and customization controls. This does not replace manual keyboard/touch testing.
