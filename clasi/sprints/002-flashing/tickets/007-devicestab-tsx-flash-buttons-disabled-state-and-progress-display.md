---
id: '007'
title: 'DevicesTab.tsx: flash buttons, disabled state, and progress display'
status: open
use-cases: []
depends-on: ["001", "006"]
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# DevicesTab.tsx: flash buttons, disabled state, and progress display

## Description

Add the two conditional flash buttons to `DevicesTab.tsx`'s
`DeviceCard`, per the linked issue: "Flash relay firmware" and "Flash
robot firmware," visible only for a device that was auto-probed and
failed to identify, disabled+explained for the robot button when
unavailable, and replaced by progress text while a flash is in-flight.
This is the last ticket in the sprint — it consumes the wire contract
(ticket 001), the live `firmwareStatus`/`flashStatus` fields server.ts
now sends (tickets 003, 005, 006), and closes the loop the issue
describes end-to-end (short of physical hardware, per the sprint's
known deferred-verification gap).

Follow this file's existing split (connected `DevicesTab` /
presentational `DevicesList`/`DeviceCard`) so button-visibility and
disabled-state logic stay testable against plain `DeviceListEntry`
fixtures, per the file's own doc comment and existing test pattern —
no real or faked socket needed for these cases.

## Acceptance Criteria

- [ ] The two buttons render if and only if `device.role === null &&
      device.linkError !== undefined` — not for an unprobed device (no
      `linkError`, no `role`) and not for an identified one (`role`
      set). Verified against plain `DeviceListEntry` fixtures for all
      three states.
- [ ] "Flash relay firmware" sends `{ type: "flash-start", deviceId,
      firmware: "relay" }` via the shared `send` from `useWs()`.
- [ ] "Flash robot firmware" renders `disabled` with its
      `firmwareStatus.robot.reason` (or a sensible default message) shown
      when `firmwareStatus.robot.configured === false ||
      firmwareStatus.robot.available === false`, using a fixture shaped
      like the real, verified zero-release `pxt-nezha-diffdrive` state
      per the sprint's Success Criteria — not a hardcoded UI flag;
      flipping the fixture's `available` value flips the rendered state.
- [ ] While `device.flashStatus` is set, both flash buttons for that
      device are hidden or disabled (no double-flash), replaced with
      phase-derived progress text (e.g. "Flashing relay firmware:
      writing…").
- [ ] `WsProvider`/`useWs()`'s context surface is extended (or a new
      subscription added) so `DevicesTab` can render live
      `flash-progress` text beyond what the `devices` snapshot's
      `flashStatus` alone conveys, following the existing `onLine`/
      `onError` subscription pattern rather than inventing a new one.
- [ ] Existing Connect/Disconnect button behavior and rendering for
      every other device state (named, unnamed, HID-only, no-port) is
      unchanged.
- [ ] `DevicesTab.test.tsx` (or wherever this file's existing tests
      live) gains cases for: buttons absent on an unprobed device;
      buttons present on a failed-identify device; robot button
      disabled+message on the zero-release fixture; both buttons
      absent/disabled while `flashStatus` is set; clicking "Flash relay
      firmware" calls `send` with the correct message shape.

## Implementation Plan

**Approach**: Extend `DeviceCard`'s `device-actions` block with the two
new buttons alongside the existing Connect/Disconnect logic (an
`if`/ternary based on `role`/`linkError`/`flashStatus`, following the
existing `roleDisplay`/`nameDisplay` helper-function style already in
this file). Extend `WsProvider`'s context value with an `onFlashProgress`
subscription (mirroring `onLine`/`onError`) if live per-phase text is
wanted beyond the snapshot's own `flashStatus.phase` (which alone may
already be sufficient — decide based on whether `flashStatus.phase`
updates frequently enough via `devices` broadcasts alone, per ticket
006's behavior, before adding a second subscription path only if
needed).

**Files to modify**:
- `packages/ui/src/components/DevicesTab.tsx`
- `packages/ui/src/components/DevicesTab.test.tsx` (or existing
  equivalent test file for this component)
- `packages/ui/src/ws/WsProvider.tsx` (only if the live-progress
  subscription above proves necessary)

**Testing plan**: Fixture-driven tests against `DevicesList`/
`DeviceCard` directly (no socket), covering the truth table in the
Acceptance Criteria above, matching this file's own established
testing philosophy (plain `DeviceListEntry` data in, rendered output
and `onOpen`/`onClose`-style callback assertions out).

**Documentation updates**: Update this file's own module doc comment
("Split into a connected `DevicesTab`... so the rendering rules for
each device state... can be exercised directly in tests") to add the
flash-button states to its list of directly-testable rendering rules.
