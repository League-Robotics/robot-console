---
id: '001'
title: Add --version option to console CLIs
status: open
use-cases: []
depends-on: []
github-issue: ''
issue: cli-version-option.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Add --version option to console CLIs

## Description

Neither console command reports its version. `rconsole --version` and
`rconsole version` both fail with "unknown command", and `robot-console`
has no version flag at all. Add version reporting to `rconsole`,
`robot-console`, and (if it parses arguments) `robot-console-supervisor`,
resolved at runtime from the root `package.json` so it works from both a
repo checkout and a global `npm link` install.

## Acceptance Criteria

- [ ] `rconsole --version`, `rconsole -V`, and `rconsole version` print
      `rconsole <version>` and exit 0. The option is listed in
      `rconsole help`.
- [ ] `robot-console --version` / `-V` prints `robot-console <version>`
      and exits 0 **without** starting the host, opening a store, or
      contacting mbregistry.
- [ ] `robot-console-supervisor --version` does the same, if it parses
      arguments.
- [ ] The version comes from the root `package.json` (the value
      `close_sprint` bumps, e.g. `0.20260925.2`), resolved at runtime
      relative to the package, correct both from the repo and from a
      global `npm link` install.
- [ ] Tests exist for each command, including one showing
      `robot-console --version` does not start anything.

## Implementation Plan

**Approach**: Add argument handling for `--version`/`-V` (and `version`
for `rconsole`) to each CLI entry point's existing arg-parsing path, as
an early check that short-circuits before any other startup logic.
Resolve the version by reading the root `package.json`'s `version`
field at runtime, located relative to the entry point's own file (e.g.
via `import.meta.url` / `__dirname` walking up to the package root)
rather than assuming a fixed cwd, so it resolves correctly both from a
repo checkout and a global `npm link` install.

**Files likely to create/modify**:
- `bin/rconsole.js` — add `--version`/`-V`/`version` handling and list
  it in `rconsole help` output.
- `bin/robot-console.js` — add `--version`/`-V` handling before host
  startup, store opening, or mbregistry contact.
- `bin/robot-console-supervisor.js` — add the same, if it parses its
  own arguments.
- A small shared helper (new file, e.g. `bin/lib/version.js` or similar,
  or inline if trivial) for resolving the package version relative to
  the entry point, to avoid duplicating the lookup logic three times.
- New/updated test files alongside existing CLI tests for these three
  entry points.

**Documentation updates**: none required beyond what `rconsole help`
already covers (updating its own help text is part of this ticket's
acceptance criteria, not a separate docs artifact).

## Testing

- **Existing tests to run**: existing CLI/argument-parsing test suites
  for `rconsole`, `robot-console`, and `robot-console-supervisor`.
- **New tests to write**: per-command tests asserting exact version
  output (`<command-name> <version>`) and exit code 0 for
  `--version`/`-V` (and `version` for `rconsole`); a test confirming
  `robot-console --version` does not start the host, open a store, or
  contact mbregistry; a test confirming version resolution works when
  invoked from a global `npm link`-style install path, not just the
  repo checkout.
- **Verification command**: `npm run test` (scoped to the CLI test
  files this ticket touches, per source-code rule — the full suite
  runs once at `close_sprint`).
