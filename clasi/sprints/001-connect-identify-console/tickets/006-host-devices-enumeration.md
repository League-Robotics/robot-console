---
id: '006'
title: 'host: devices.ts (DAPLink USB enumeration)'
status: pending
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# host: devices.ts (DAPLink USB enumeration)

## Description

Build `packages/host/src/devices.ts`, which enumerates DAPLink micro:bit
devices attached to the host machine and joins their two USB personas
into one record. Per `sprint.md`'s Architecture and
`docs/design/specification.md` §4.1:

- Filter `serialport`'s device list to DAPLink's `VID 0x0D28 / PID
  0x0204`.
- Key/join on `serial_number` — this is **the same join key used across
  the rest of the fleet tooling** (`mbdeploy`, `mbrelay`), so do not
  invent a different join strategy; a device's serial-port record and
  its `node-hid` CMSIS-DAP record must be joined on this exact field so
  `swdName.ts` (ticket 007) can find the right HID handle for a given
  serial port.
- Also enumerate the CMSIS-DAP HID interface via `node-hid`, joined the
  same way, since `swdName.ts` needs it to attach over SWD.

This module only enumerates and joins — it does not compute names (that
is `swdName.ts`, ticket 007) and does not open a data link (that is
`UsbSerialLink`, ticket 008). Keep the boundary narrow: its output is a
list of joined device records (serial port info + HID handle + USB
serial number), nothing more.

Support both a one-shot enumeration call and a way to detect
attach/detach changes over time (polling or `serialport`'s own
attach/detach events, implementer's choice) — `server.ts` (ticket 009)
needs live updates, not just a snapshot at startup, to satisfy "student
plugs in a micro:bit" as a live event rather than something requiring a
page refresh.

## Acceptance Criteria

- [ ] Enumerates only devices matching `VID 0x0D28 / PID 0x0204`,
      ignoring unrelated USB serial devices.
- [ ] Each returned record includes the `serial_number`, the serial
      port path, and a reference/handle to the matching `node-hid`
      CMSIS-DAP interface, all joined on `serial_number`.
- [ ] A device present in `serialport`'s list but with no matching
      `node-hid` entry (or vice versa) is handled explicitly (surfaced
      as partially-available, not silently dropped or silently treated
      as fully available).
- [ ] Plugging in or unplugging a device is observable by callers
      (event/callback or poll-and-diff) without restarting the process.
- [ ] Unit-testable logic (the VID/PID filter and the join-by-
      serial_number logic) is separated from the actual `serialport`/
      `node-hid` calls so it can be tested against fake device lists
      without real hardware attached; a hardware-dependent smoke test is
      exercised manually per this sprint's Success Criteria, not as part
      of `npm test`.

## Testing

- **Existing tests to run**: `npm test` (protocol suite continues
  passing; this is the first `host`-package test).
- **New tests to write**: unit tests for the VID/PID filter and the
  join-by-`serial_number` logic against synthetic/fake device-list
  fixtures (no real hardware). A real-hardware enumeration is verified
  manually, not via `npm test`.
- **Verification command**: `npm test -- packages/host` for the unit
  logic; manual verification with a real device attached for the live
  enumeration path.

## Implementation Plan

**Approach**:
1. Add `serialport` and `node-hid` as `packages/host` dependencies.
2. Implement the VID/PID filter over `serialport.list()`'s output as a
   small, pure function taking a device-list array and returning the
   matching subset — this is the part unit-tested without hardware.
3. Implement the `node-hid` CMSIS-DAP enumeration similarly, as a pure
   function over `HID.devices()`'s output.
4. Implement the join-by-`serial_number` logic as a pure function
   combining the two filtered lists, with explicit handling for the
   partial-match case.
5. Wrap the three pure functions in a thin live layer (poll-and-diff, or
   `serialport`'s attach/detach events if reliable enough — implementer's
   judgment) that `server.ts` (ticket 009) can subscribe to.
6. Write unit tests against synthetic device-list fixtures covering:
   VID/PID filtering, successful join, and the partial-match case.

**Files to create**:
- `packages/host/src/devices.ts`
- `packages/host/src/devices.test.ts`

**Files to modify**:
- `packages/host/package.json` (add `serialport`, `node-hid`
  dependencies).

**Testing plan**: `npm test` for the pure filter/join logic; manual
verification against real DAPLink hardware for the live-enumeration
path, folded into this sprint's overall hardware smoke test.

**Documentation updates**: none beyond inline comments on why
`serial_number` is the join key (shared convention across the fleet
tooling, per specification §4.1).
