---
status: pending
---

# Sprint 002 flash path is unverified against real hardware

## Description

Sprint 002 built the whole firmware-flashing path — config, release
fetch with sha256 verification, universal-hex v2 extraction, SWD
flashing, registry orchestration, server wiring, and the two Devices-tab
buttons — with **no micro:bit available to flash**. Every ticket's
hardware-dependent criteria were explicitly deferred rather than checked
off, which is the right outcome, but it leaves the sprint's headline
behavior unproven end to end.

Proven by tests, without hardware:
- Release resolution for `latest` and for a pinned tag, the zero-release
  404 path, sha256 match and mismatch, lenient manifest parsing.
- Universal-hex v2 extraction against fixture bytes.
- That an invalid hex never reaches an attach or erase.
- Registry orchestration, including failure recovery and mutex ordering
  against a concurrent open.
- Server fan-out of progress/result to multiple clients, and cache
  teardown on close.
- Button visibility across all three identify states, disabled copy, and
  the availability flip.

Not proven, because it needs a board:
- That a real DAPLink attach → erase → write → reset sequence actually
  programs a micro:bit.
- That a flashed board then announces and identifies with the expected
  role.
- Real progress-event timing (the `erasing`/`writing`/`resetting` phases
  are emitted around DAPjs's single atomic `flash()` call, not derived
  from true device state).
- The MSD fallback end to end — see
  `msd-fallback-volume-matching-heuristic-unimplemented.md`.

## Cause

Not a code defect. No micro:bit running cooperating firmware has been
available since sprint 001; see
`sprint-001-hardware-criteria-unverified-no-announcing-board.md`, which
records the same gap for the identify path.

## Proposed fix

With a physical micro:bit attached, click **Flash relay firmware** on a
board that fails to identify and confirm: the hex is fetched and
verified, progress advances through the phases, the board reboots, and
it then identifies with a `RADIOBRIDGE` or `RADIORELAY` role. This also
closes the role-rendering half of the sprint 001 gap, since a
successfully flashed relay is exactly the announcing board that issue
has been waiting for.

## Verification

A board that showed `linkError` and no role, flashed from the Devices
tab, subsequently shows its five-letter name and a relay role.
