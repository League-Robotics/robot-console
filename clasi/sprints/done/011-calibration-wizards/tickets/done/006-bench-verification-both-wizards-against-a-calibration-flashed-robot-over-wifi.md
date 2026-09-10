---
id: '006'
title: 'Bench verification: both wizards against a calibration-flashed robot over
  WiFi'
status: done
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

- [x] Confirm the target board (`gopiv` or `tigez`) is running
      `nezha-robot-template`, flashing it via the console's existing
      release-flash path if it is not already.
- [x] Confirm the board classifies as `calibration` (ticket 001) via its
      `ID` reply, and the front page / device page show that
      classification (ticket 002).
- [x] Confirm `calx`/`cala` both appear in a `FUNCS` response taken over
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
- [x] Exercise at least one real failure path on the bench (e.g. start
      the distance wizard with no lines laid down, or interrupt the
      rotation wizard's cross-following) and confirm the panel shows a
      distinct failure state, not a hang or a fabricated snippet.
- [x] Record which criteria were exercised and which were not (if any
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

## Bench Notes (2026-09-10)

- **Board and firmware.** Board: `gopiv`. Firmware: nezha-robot-template
  calibration image, program `calibration-0.20260910.3`,
  pxt-nezha-diffdrive extension `1.20260909.2`. Image: release
  MICROBIT.hex sha256 starting `9b18abd9`.

- **Flash method.** The board was flashed over the farm host's USB via
  `mbdeploy deploy --remote gopiv`, NOT via the console's own
  release-flash path — `gopiv` is attached to the farm host, not to the
  console machine's USB. Criterion 1 is checked on the strength of the
  board demonstrably running the template image, not on the console
  flash path being exercised. After flashing, WiFi credentials were
  re-provisioned with `WIFICRED SET 0 ...` over the same USB serial and
  the board was power-cycled by the stakeholder; it rejoined WiFi and
  appeared as `wifi-gopiv`.

- **Classification (criterion 2).** `ID` reply over farm USB serial:
  `id diffdrive calibration-0.20260910.3 1.20260909.2 gopiv`. Front page
  card showed the badge "Calibration robot · 1.20260909.2"; the robot
  page diagnostics line showed "Program: calibration-0.20260910.3 ·
  Version: 1.20260909.2"; the panel list included "Distance
  calibration" and "Rotation calibration".

- **FUNCS cross-check (criterion 3).** Transport = USB serial via the
  farm host (`mbdeploy connect --remote gopiv`). All 17 functions
  listed, including `calx` and `cala`, each with its parameter
  signature.

- **Wizard runs.** All wizard runs were driven through the real UI in
  headless Chromium (Playwright) at `http://localhost:5173/d/wifi-gopiv`,
  i.e. over the WiFi link (TCP 7654). No page errors were logged.

- **Distance wizard (criterion 4, NOT checked).** The wizard ran end to
  end mechanically: Go dispatched `RUN calx`, the panel showed the
  `CALX:begin true=90cm baseline=0.7878mm/deg` / `CALX:start line found`
  progress events, and a run finished with `CALX:apply
  diffDrive.setWheelCalibration(1.0121)` after `CALX:measured=70.06cm
  true=90cm`. However the robot was on the bench with NO tape lines
  laid 90 cm apart, so the reflectance events were bench artifacts and
  the resulting number is not a physical measurement. The UI path is
  verified; the physical measurement is not. Not checked for that
  reason.

- **Rotation wizard (criterion 5, NOT checked).** No black-tape cross
  was laid. Runs reached `CALA:begin track=11.5cm slip=0.952
  b=12.08cm` and `CALA:pass clockwise` (the pass stages rendered), and
  a further run terminated with `CALA:fail saw 0 transitions, need 5 --
  never saw clear floor, is it parked on the cross?`. A `CALA:apply`
  snippet with the firmware's re-verification pass was not observed on
  the bench. Not checked for that reason.

- **Failure paths (criterion 6, checked).** (a) Rotation wizard started
  with no cross: panel showed the distinct state "Calibration failed:
  saw 0 transitions, need 5 -- never saw clear floor, is it parked on
  the cross?". (b) Distance wizard interrupted with the drive pad's
  STOP button 3 s after Go: the robot acked `STOP now` (`ack 21 0
  none`), the firmware's calx search continued to its own limit and
  emitted `CALX:fail no end line between 70 and 110cm`, and the panel
  showed "Calibration failed: no end line between 70 and 110cm".
  Neither case hung at "Running…" or fabricated a snippet. Note for a
  later reader: STOP does not abort a running calx in this firmware —
  the run ends via calx's own distance limit a few seconds later.

- **Not exercised.** The physical-measurement halves of criteria 4 and
  5 (no lines, no cross available on the bench at session time).
  Everything else above was actually run.

- **Screenshots.** Kept in the session scratchpad, not committed:
  shot-7-front-calibration.png, shot-8-distance-wizard.png,
  shot-9-rotation-wizard.png, shot-10-distance-interrupted.png.
