---
id: '006'
title: 'Bench verification: both wizards against a calibration-flashed robot over
  WiFi'
status: open
use-cases:
- SUC-001
- SUC-003
- SUC-004
depends-on:
- '003'
- '004'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: both wizards against a calibration-flashed robot over WiFi

## Description

This ticket isolates every hardware-only claim from SUC-001/003/004
into one clearly-labeled ticket, per this sprint's own Test Strategy —
no other ticket's fake-provable acceptance criteria depend on this one
closing (mirroring sprint 010's own SUC-006 precedent).

`gopiv`/`tigez` are reachable over WiFi right now (per this session's
verified facts) — use them as the bench targets rather than requiring
a fresh USB flash session, superseding the roadmap's blanket "default
to USB/radio, not WiFi" note (written before today's live-hardware
check). One caveat carried forward from the WiFi-`FUNCS`-truncation
finding: a multi-line `FUNCS` listing can truncate over WiFi, so this
ticket cross-checks `calx`/`cala`'s presence in `FUNCS` over USB (or
radio) at least once, even while running the wizards themselves over
WiFi — the wizards' own traffic (`RUN` plus a stream of ordinary rx
lines) is not known to be affected by that bug.

If the target board is not already running `nezha-robot-template`,
flashing it is in scope for this ticket as a bench step (using the
console's existing, unmodified release-flash path — see `sprint.md`'s
Scope, "no *new* flashing work is in scope") but is not itself a new
acceptance criterion this sprint's other tickets depend on.

## Acceptance Criteria

- [ ] Confirm the target board (`gopiv` or `tigez`) is running
      `nezha-robot-template`, flashing it via the console's existing
      release-flash path if it is not already.
- [ ] Confirm the board classifies as `calibration` (ticket 001) via its
      `ID` reply, and the front page / device page show that
      classification (ticket 002).
- [ ] Confirm `calx`/`cala` both appear in a `FUNCS` response taken over
      USB or radio at least once this session (cross-checking the
      WiFi-`FUNCS`-truncation risk, per the Description above) —
      record which transport this check used.
- [ ] Run the distance wizard (ticket 003) end to end against the two
      physical lines laid 90 cm apart; confirm it produces a plausible
      `CALX:apply diffDrive.setWheelCalibration(...)` snippet.
- [ ] Run the rotation wizard (ticket 004) end to end against a
      black-tape cross; confirm it produces a plausible `CALA:apply
      diffDrive.setConfigValue(ConfigField.RotationalSlip, ...)`
      snippet, having visibly gone through both measurement passes and
      the firmware's own re-verification pass.
- [ ] Exercise at least one real failure path on the bench (e.g. start
      the distance wizard with no lines laid down, or interrupt the
      rotation wizard's cross-following) and confirm the panel shows a
      distinct failure state, not a hang or a fabricated snippet.
- [ ] Record which criteria were exercised and which were not (if any
      hardware wasn't available at session time) — an honestly reported
      "not exercised, here's why" is an acceptable outcome; a criterion
      not actually run is never checked off.

## Implementation Plan

**Approach:** a bench session, not a code change. No files are expected
to change as part of this ticket unless the bench session surfaces a
real defect in tickets 001-004's work, in which case that defect is
fixed via a follow-up ticket or issue, not silently patched into this
verification ticket.

**Testing plan:** this ticket's own acceptance criteria are the test
plan; there is no separate `vitest` suite for it.

**Documentation updates:** record the bench session's board name(s),
firmware version, and transport used for each check (per the
`measurement-citations` discipline applied elsewhere in this project's
firmware work) in this ticket's own notes when closing it, so a later
reader can tell what was actually run rather than assumed.
