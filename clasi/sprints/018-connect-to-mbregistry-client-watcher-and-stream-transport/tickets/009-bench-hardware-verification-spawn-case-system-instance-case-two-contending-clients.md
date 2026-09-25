---
id: 009
title: 'Bench/hardware verification: spawn case, system-instance case, two contending
  clients'
status: open
use-cases:
- SUC-001
- SUC-002
- SUC-004
- SUC-005
- SUC-007
- SUC-008
depends-on:
- '001'
- '002'
- '003'
- '004'
- '005'
- '006'
- '007'
- 008
- '010'
github-issue: ''
issue:
- use-mbregistry-for-boards-locks-and-flashing.md
- retire-direct-usb-flash-and-names-via-mbregistry.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench/hardware verification: spawn case, system-instance case, two contending clients

## Description

Every prior ticket in this sprint tests against a fake JSON-lines/binary
server (sprint.md's Test Strategy: "tests must not require a real
mbregistry"). This ticket is the one pass against a real, installed
mbregistry and real hardware, per the sprint's own success criteria and
SUC-001/SUC-004/SUC-005/SUC-007/SUC-008's acceptance lists — it cannot be
automated in CI and must be run and recorded by hand (mirroring this
project's existing `docs/acceptance/*-hardware.md` convention, if one
exists, or creating the first entry for mbregistry integration).

Cases to exercise on the bench:

1. **Spawn case**: no mbregistry running; start robot-console; confirm it
   spawns one, discovers a locally-plugged board through it, opens a
   session, and that the spawned mbregistry process exits when
   robot-console exits.
2. **System-instance case**: a system/user mbregistry already running
   (started independently, e.g. via `mbregistry run` by hand or an
   installed service); start robot-console; confirm it connects to the
   existing instance and does not spawn a second one.
3. **Two contending clients**: with one board attached, open it from
   robot-console; from a second client (e.g. `mbregistry list`/a second
   robot-console instance, or a raw `lock` call) attempt to open the same
   board; confirm the second sees "in use by <label>" (or plain "in use"
   if the installed mbregistry predates label support), and that a
   deliberately-forced `mbregistry unlock --force <name>` on the owning
   host is reflected as end-of-file/reconnect on the first client's side
   — no crash, no double-open.
4. **Relay reset on real hardware**: bridge a robot through a relay
   discovered via mbregistry (ticket 007) and confirm the reset-between-
   candidates step actually resets the relay physically (an oscilloscope
   or observed reboot-behavior check, matching how prior relay-bridging
   tickets in this codebase verified their own reset step on the bench).
5. **Minimum version check**: confirm startup fails cleanly against an
   installed mbregistry below `MIN_MBREGISTRY_VERSION` (ticket 001),
   with the exact message a stakeholder would see.
6. **Flash a local board through mbregistry** (ticket 005): flash a
   locally-plugged board discovered via mbregistry, including the case
   where this console currently has an open session on it (confirm the
   session closes and the flash still succeeds, per ticket 005's
   session-lock cooperation design).
7. **Flash a remote board through mbregistry** (ticket 005): from this
   console, flash a board attached to a *different* host's mbregistry
   instance, confirming the flash connects directly to the owning
   host's remote port and the board re-identifies afterward through
   `mbregistryWatcher`'s `watch` events without any manual refresh.

Record results (pass/fail per case, any surprises) in a short bench
report the stakeholder can review before closing the sprint — this
ticket's own "Testing" section is where that report's location/format
should be decided at implementation time, following whatever convention
this project already uses for hardware acceptance (check
`docs/acceptance/` first).

## Acceptance Criteria

- [ ] Spawn case passes: robot-console spawns mbregistry, uses it,
      discovers a real local board, opens a session; the spawned process
      exits when robot-console exits.
- [ ] System-instance case passes: robot-console connects to a
      pre-existing mbregistry and does not spawn a second one.
- [ ] Two-contending-clients case passes: the second client's failure
      message names the holder (or degrades gracefully), and a forced
      unlock is observable by the first client without a crash.
- [ ] Relay reset via mbregistry is confirmed on real hardware to
      actually reset the relay between candidates.
- [ ] Minimum-version-check failure is confirmed against a real
      below-minimum (or simulated-version) mbregistry binary.
- [ ] A local board flashes successfully through mbregistry, including
      when this console has it open at the start of the check.
- [ ] A remote (peer-host) board flashes successfully through
      mbregistry, and re-identifies afterward with no manual refresh.
- [ ] Results are written up per this project's existing hardware-
      acceptance documentation convention (or a new one started here if
      none exists yet), reviewed by the stakeholder before sprint close.

## Implementation Plan

- **Approach**: manual/bench execution against real mbregistry and real
  micro:bit hardware — not a `vitest` suite. Pair with whichever
  hardware-acceptance hosts this project already uses (`CLAUDE.md`
  references bench hosts including a Mac — confirm current hosts before
  scheduling this ticket).
- **Files to create**: a bench report doc, location/naming to match this
  project's existing `docs/acceptance/` (or equivalent) convention — pick
  the actual path at implementation time by checking what's there.
- **Testing plan**: the seven cases above, executed by hand, each with a
  clear pass/fail and enough detail (exact commands run, exact messages
  seen) that another engineer could reproduce the check.
- **Documentation updates**: the bench report itself; a short pointer
  from `docs/design/robot-console-integration.md`'s own status notes (if
  that doc tracks sprint completion, per its mbtools-side precedent) is
  optional and out of this ticket's required scope (that doc lives in
  the mbtools repo, not this one).
