---
id: '010'
title: 'Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving'
status: open
use-cases: [SUC-002, SUC-003, SUC-004, SUC-005, SUC-006, SUC-007]
depends-on: ['001', '002', '003', '004', '005', '006', '007', '008', '009']
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving

## Description

Final gate for the sprint: run the full test suite (this is the one
full-suite run per sprint, per `.claude/rules/source-code.md`, done
inside `close_sprint`'s pre-close gate — this ticket's job is to make
sure the suite is green and the two carried hardware items from sprint
016 ticket 008 are verified before that gate runs) and complete the two
bench items sprint.md carries forward: (1) a `_robotlink`-advertising
robot connects over WiFi and answers a command; (2) the stakeholder
physically drives a robot over USB and over radio via a relay.
**Precondition**: `npm run dev` stopped, a `_robotlink` robot present,
a healthy USB cable for the robot board (the previous cable was
suspect after sprint 016). **No firmware flashing by agents** — this
ticket verifies existing firmware behavior; it does not flash new
firmware to any bench device.

## Acceptance Criteria

- [ ] Full test suite passes on macOS.
- [ ] Full test suite passes on Linux (or the platform-specific
      subset that can run in this environment — the MSD Linux paths
      from ticket 004 are covered by unit tests regardless; a Linux CI/
      bench run is the additional check here if available).
- [ ] A robot advertising `_robotlink` connects over WiFi and answers a
      command (carried item 1 from sprint 016 ticket 008).
- [ ] The stakeholder physically drives a robot over USB (carried item
      2a).
- [ ] The stakeholder physically drives a robot over radio via a relay
      (carried item 2b).
- [ ] Every duplicate row in `docs/reviews/2026-09-11/04-ui.md` §4 is
      confirmed resolved (cross-check against tickets 007/008's
      completion notes).
- [ ] `specification.md`'s corrected claims (ticket 009) spot-checked
      against the running system where practical (e.g., verb count via
      an actual session).
- [ ] No firmware was flashed to bench hardware during this ticket.

## Implementation Plan

**Approach**: This ticket is verification, not new implementation.
Run the scoped test suites from tickets 001–009 already passing
individually, then run the full suite once. Coordinate the hardware
bench pass with the stakeholder (WiFi leg and physical driving require
a human at the bench, per the sprint's carried-items note).

**Files**: None created; this ticket may add a small full-suite CI
config note if one is missing, but is primarily a verification pass.

**Testing plan**:
- `npm test` (full suite) on macOS.
- Full suite on Linux where available.
- Bench: WiFi leg — `_robotlink` robot connects, answers a command
  (e.g. `STATUS`).
- Bench: USB drive — student-style drive commands (`WHEELS_V`/`STOP`)
  against a USB-connected robot.
- Bench: radio drive — same, bridged through a relay.

**Documentation updates**: Record bench results (which hardware was
used, pass/fail per item) in this ticket's completion notes for the
sprint's close-out review.
