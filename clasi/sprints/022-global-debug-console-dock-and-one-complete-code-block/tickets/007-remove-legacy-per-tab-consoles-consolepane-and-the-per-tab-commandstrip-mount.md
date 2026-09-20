---
id: "007"
title: "Remove legacy per-tab consoles, ConsolePane, and the per-tab CommandStrip mount"
status: open
use-cases: ["SUC-001"]
depends-on: ["006"]
github-issue: ""
issue: ""
# completes_issue: Controls whether linked issues are archived when this ticket
# is moved to done. Default: true (archive when all referencing tickets are done).
# Set to false (scalar) to suppress archival for ALL linked issues on this ticket.
# Set to a mapping {filename.md: false} to suppress archival per issue filename.
# Use false for tickets that partially address a multi-sprint umbrella issue.
completes_issue: true
# exception: Written by a lower agent when it cannot proceed (see architecture §exception-protocol).
# exception:
#   thrown_by: "programmer"          # "programmer" | "sprint-planner"
#   thrown_at: "2026-05-07T14:23:00Z"
#   attempted: |
#     Description of what was attempted before giving up.
#   conflict: "architecture-update.md §3 — reason the agent is blocked"
#   surface: "internal"              # "user-visible" | "internal"
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Remove legacy per-tab consoles, ConsolePane, and the per-tab CommandStrip mount

## Description

With `ConsoleDock` fully working (tickets 002-006: relocation, toggle,
resize, pop-out, route-driven lifecycle all verified live), remove
every remaining per-tab console mount and the now-dead `ConsolePane.tsx`
itself. This is the final ticket precisely so the dock was proven
complete before its predecessor was deleted — per sprint.md's Migration
Concerns, showing both the dock and the legacy per-tab consoles
simultaneously in tickets 002-006 was intentional incremental delivery,
not a defect; this ticket is where that overlap ends.

Remove, per sprint.md's confirmed call-site list:
- `<ConsolePane>` from `RobotPage.tsx` (Main tab), `RelayPage.tsx`,
  `UnknownDevicePage.tsx`, `DriveTab.tsx`, `CalibrationPage.tsx`,
  `ConfigurationPage.tsx` — six mount sites.
- `<CommandStrip>` from `RobotPage.tsx`'s Main tab (its only mount
  site outside the dock).
- `ConsolePane.tsx` and `ConsolePane.test.tsx` themselves — the
  component's one job (viewport-fit sizing) is superseded by the
  dock's own fixed-position-plus-drag-resize layout (ticket 003/004).

`DeviceConsole.tsx`, `CommandStrip.tsx`, `SequencingIndicator.tsx`
themselves are **not** deleted or modified — they remain, now used
only from `console-dock/`.

Each touched page's column CSS reserved space for its own embedded
console (`robot-page-column-console` and similar classes); reclaim
that space now that the console is gone from the column, rather than
leaving a dead gap. Check `RobotPage.css`/`RelayPage.css`/
`CalibrationPage.css`/`ConfigurationPage.css`/`DriveTab.css` (and
their doc comments, several of which explicitly reference the
console-reserving classes) for what needs adjusting.

Per this ticket's Testing Strategy note in sprint.md: don't simply
delete the per-page tests that asserted a console was present in that
tab — replace them with assertions that no per-tab console renders
there (and that the dock is the only place the log/controls appear).
Coverage moves, it doesn't disappear.

## Acceptance Criteria

- [ ] `grep -rn "ConsolePane" packages/ui/src` returns no matches
      outside `console-dock/`'s own history (i.e. the file and all its
      mount sites are gone).
- [ ] `CommandStrip` has exactly one runtime mount site left: inside
      `console-dock/ConsoleDock.tsx`.
- [ ] `RobotPage.test.tsx`, `RelayPage.test.tsx`,
      `UnknownDevicePage.test.tsx`, `DriveTab.test.tsx`,
      `CalibrationPage.test.tsx`, `ConfigurationPage.test.tsx` each
      assert the *absence* of a per-tab console/`CommandStrip` and
      that the dock alone carries the log — not simply have their old
      console assertions deleted with nothing put in their place.
- [ ] Each touched page's column layout reclaims the space previously
      reserved for its embedded console (no dead gap where the console
      used to sit).
- [ ] `DeviceConsole.tsx`, `CommandStrip.tsx`, `SequencingIndicator.tsx`
      are unmodified — their own existing test files pass unchanged.
- [ ] The stakeholder's Success Criteria from sprint.md — "there is
      exactly one console on screen, in the bottom dock — never a
      per-tab embedded console" — holds on every device page,
      confirmed live.

## Implementation Plan

**Approach**: Delete-and-reflow, one page at a time, running that
page's own scoped test file after each removal so a layout regression
is caught immediately rather than discovered after all six are done.

**Files to delete**:
- `packages/ui/src/components/ConsolePane.tsx`
- `packages/ui/src/components/ConsolePane.test.tsx`

**Files to modify**:
- `packages/ui/src/pages/RobotPage.tsx` (+ `.css`, `.test.tsx`) —
  remove Main tab's `ConsolePane`/`CommandStrip`, reclaim layout space.
- `packages/ui/src/pages/RelayPage.tsx` (+ `.css`, `.test.tsx`) —
  remove `ConsolePane`.
- `packages/ui/src/pages/UnknownDevicePage.tsx` (+ `.test.tsx`) —
  remove `ConsolePane`.
- `packages/ui/src/components/DriveTab.tsx` (+ `.css`, `.test.tsx`) —
  remove `ConsolePane`, reclaim layout space.
- `packages/ui/src/components/CalibrationPage.tsx` (+ `.css`,
  `.test.tsx`) — remove `ConsolePane`.
- `packages/ui/src/components/ConfigurationPage.tsx` (+ `.css`,
  `.test.tsx`) — remove `ConsolePane`.

**Testing plan**: `npm test` scoped to each modified module as it's
touched (`npm test -- RobotPage`, then `RelayPage`, etc., from
`packages/ui`), foreground, then a final scoped run across all touched
modules together to catch cross-file regressions:
`npm test -- RobotPage RelayPage UnknownDevicePage DriveTab
CalibrationPage ConfigurationPage ConsolePane console-dock`. The full
suite runs once at `close_sprint`, not in this ticket.

**Documentation updates**: None beyond code comments explaining why
each removed mount is gone (point to the dock) — matches this
codebase's house style of dated, WHY-focused comments.

## Testing

- **Existing tests to run**: the full set of touched pages' test files
  (see Files to modify above), run incrementally.
- **New tests to write**: absence-of-per-tab-console assertions in
  each touched page's test file (see Acceptance Criteria).
- **Verification command**: `npm test -- RobotPage RelayPage
  UnknownDevicePage DriveTab CalibrationPage ConfigurationPage
  ConsolePane console-dock` (run from `packages/ui`), plus a live
  Chromium walkthrough of every device page/tab confirming exactly one
  console (the dock) is ever visible.
