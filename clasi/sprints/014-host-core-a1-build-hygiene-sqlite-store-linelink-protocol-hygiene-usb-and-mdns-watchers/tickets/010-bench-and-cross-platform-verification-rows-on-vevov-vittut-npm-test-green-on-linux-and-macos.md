---
id: "010"
title: "Bench and cross-platform verification: rows on Vevov/Vittut, npm test green on Linux and macOS"
status: open
use-cases: [SUC-001, SUC-002, SUC-003, SUC-004, SUC-005, SUC-006]
depends-on: ["009"]
github-issue: ""
issue: ""
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench and cross-platform verification: rows on Vevov/Vittut, npm test green on Linux and macOS

## Description

This is the sprint's exit-criterion ticket, not new feature work: run
the full suite on both Linux and macOS from a clean clone; plug in both
bench boards (**Vevov** at `/dev/cu.usbmodem2121302` and **Vittut** at
`/dev/cu.usbmodem2121402`) and confirm each appears as a device+link row
in the debug dump (ticket 009) after identification; confirm the old
`deviceRegistry.ts`/coordinator path and the UI are unaffected (no
regression); confirm mDNS rows populate for whatever advertises on the
bench network. No firmware is flashed onto either board as part of this
ticket.

This is the checkpoint the sprint's Risk note calls for: "do not start
A2 (sprint 015) until A1's watcher rows are visible in a debug dump."

## Acceptance Criteria

- [ ] `npm test` is green on a clean clone on both Linux and macOS, with
      no dirty files afterward (rearch-17's own acceptance criterion,
      re-verified here as the sprint's regression gate).
- [ ] Both **Vevov** and **Vittut**, plugged into this Mac's USB hub,
      appear as `devices`/`links(usb)` rows in the debug-dump output
      after identification (SUC-001's bench criterion).
- [ ] Unplugging either board ages its link to `stale` within one poll
      in the dump (SUC-002).
- [ ] Any mDNS-advertising device on the bench network produces
      `services`/`links` rows in the dump (SUC-003/004).
- [ ] `known-robots.json`'s existing entries appear as `owned = 1`
      device rows before any watcher runs (SUC-005).
- [ ] The UI, run against the unchanged `deviceRegistry.ts` path, shows
      no regression — same devices, same behavior as before this
      sprint's changes.
- [ ] No firmware is flashed onto Vevov or Vittut during this
      verification.

## Testing

- **Existing tests to run**: the complete `npm test` suite (this is the
  one place in the sprint where the full suite runs, per this project's
  `source-code.md` rule that the full suite runs once per sprint at
  close, not per ticket — this ticket's manual bench pass supplements
  that automated gate rather than replacing it).
- **New tests to write**: none — this ticket is verification, not new
  code, aside from any small fixup its findings require.
- **Verification command**: `npm test` (full suite, both platforms) plus
  the manual bench procedure above.

## Implementation Plan

**Approach**: Run the automated suite first on both platforms; then do
the manual bench pass with both boards attached, using ticket 009's dump
tool to inspect rows at each step (attach, identify, detach, mDNS
observation if applicable on the bench network). Record the dump output
as evidence that the sprint's exit criterion is met before sprint 015
is detail-planned.

**Files to create/modify**: none expected; if the bench pass surfaces a
defect, file it against the relevant ticket (001-008) rather than
patching silently here, since each of those tickets' own acceptance
criteria should already have caught it — a bench-only failure indicates
a gap in that ticket's test coverage worth noting for future sprints.

**Documentation updates**: none, beyond recording the bench pass result
in the ticket itself when closed.
