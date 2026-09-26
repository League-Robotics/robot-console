---
id: '026'
title: CLI --version option
status: ticketing
branch: sprint/026-cli-version-option
use-cases: []
issues: []
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 026: CLI --version option

## Goals

Give both console CLIs a working `--version` option so users and scripts
can determine which build they're running without starting a host,
opening a store, or contacting mbregistry.

## Problem

Neither console command reports its version today: `rconsole --version`,
`rconsole -V`, and `rconsole version` all fail with "unknown command",
and `robot-console` has no version flag at all.

## Solution

Add `--version`/`-V` (and `version` for `rconsole`) handling to
`rconsole`, `robot-console`, and `robot-console-supervisor` (if it
parses arguments). Each prints `<command-name> <version>` and exits 0.
The version is resolved at runtime from the root `package.json`, so it
works both from a repo checkout and a global `npm link` install.
`robot-console --version` must short-circuit before any host startup,
store, or mbregistry contact.

## Success Criteria

- `rconsole --version`, `rconsole -V`, and `rconsole version` each
  print `rconsole <version>` and exit 0.
- `rconsole help` lists the version option.
- `robot-console --version`/`-V` prints `robot-console <version>`,
  exits 0, and does not start the host, open a store, or contact
  mbregistry.
- `robot-console-supervisor --version` behaves the same way, if it
  parses its own arguments.
- Tests cover each command, including a test asserting
  `robot-console --version` starts nothing.

## Scope

### In Scope

- Version flag/subcommand handling for `rconsole`, `robot-console`, and
  `robot-console-supervisor`.
- Runtime resolution of the version string from the root
  `package.json`, working from both a repo checkout and a global
  `npm link` install.
- Tests for each command's version output and exit behavior.

### Out of Scope

- Any change to the version bump/tagging mechanism itself
  (`close_sprint`'s `dotconfig version bump`).
- Any other CLI flags or subcommands.

## Test Strategy

Unit/CLI-level tests per command asserting exact stdout format and
exit code 0, plus one test confirming `robot-console --version` does
not start the host, open a store, or contact mbregistry. No
integration or system-level testing needed — this is a self-contained,
side-effect-free flag.

## Architecture

Trivial — adds a version flag to existing CLI entry points, reading a
value already present in `package.json`. No new module, no
cross-module dependency, no data-model change. No architectural impact.

### Architecture Overview

N/A — trivial.

### Design Rationale

N/A — trivial.

### Migration Concerns

None.

## Use Cases

### SUC-001: Check console CLI version
Parent: N/A (operational/tooling use case, not tied to an existing
product UC)

- **Actor**: Developer or operator running a console CLI
- **Preconditions**: `rconsole`, `robot-console`, or
  `robot-console-supervisor` is installed (repo checkout or global
  `npm link`)
- **Main Flow**:
  1. User runs the command with `--version` (or `-V`, or `version` for
     `rconsole`).
  2. The command resolves its version from the root `package.json` and
     prints `<command-name> <version>`.
  3. The command exits 0 without starting any host, store, or
     mbregistry connection.
- **Postconditions**: The version string is printed; no other side
  effects occurred.
- **Acceptance Criteria**:
  - [ ] `rconsole --version`, `rconsole -V`, and `rconsole version`
        print `rconsole <version>` and exit 0.
  - [ ] `rconsole help` lists the version option.
  - [ ] `robot-console --version`/`-V` prints `robot-console <version>`,
        exits 0, and starts nothing.
  - [ ] `robot-console-supervisor --version` behaves consistently, if
        it parses arguments.
  - [ ] Version resolves correctly from both a repo checkout and a
        global `npm link` install.

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|
| 001 | Add --version option to console CLIs | (none) |

Tickets execute serially in the order listed.
