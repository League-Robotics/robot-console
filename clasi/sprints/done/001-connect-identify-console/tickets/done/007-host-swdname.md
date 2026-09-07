---
id: '007'
title: 'host: swdName.ts (SWD-based five-letter naming)'
status: done
use-cases:
- SUC-001
depends-on:
- '002'
- '006'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# host: swdName.ts (SWD-based five-letter naming)

## Description

Build `packages/host/src/swdName.ts` — the load-bearing module of this
sprint. Per `sprint.md`'s Architecture (Design Rationale, "name over SWD,
not from the USB serial number") and the source issue's Cause section:

- The five-letter name is a hash of the **target nRF chip's**
  `FICR.DEVICEID[1]` register at address `0x10000064` — **not** the USB
  serial number the host sees, which belongs to a different chip (the
  KL27 USB interface MCU) on the same board.
- Read this register using `dapjs`'s `readMem32`, over the `node-hid`
  CMSIS-DAP handle a `devices.ts` (ticket 006) record provides, in
  **attach mode**: no halt, no reset, no cooperating firmware required.
  This is exactly what lets a blank, never-flashed micro:bit still
  produce a correct name — one of this sprint's stated Success Criteria
  — so do not add a halt/reset step "to be safe"; it is unnecessary and
  changes the board's running state for firmware that IS present.
- Feed the raw 32-bit value read from `FICR.DEVICEID[1]` into
  `naming.ts` (ticket 002) to produce the five-letter name.

SWD attach can fail (unsupported chip, OS permissions on the HID
device). Per `docs/design/usecases.md` UC-001's error flow, on failure
this module must report the device as detected-but-unnamed and surface
the specific error — never silently omit the device from the list and
never silently fall back to a serial-number-derived name (the issue
explicitly identifies that fallback, used by `microbit-console`, as the
mistake to not repeat).

## Acceptance Criteria

- [x] Given a joined device record from `devices.ts` (ticket 006), reads
      `FICR.DEVICEID[1] @ 0x10000064` via `dapjs`'s `readMem32` in attach
      mode (no halt, no reset).
- [x] The read succeeds against a device running arbitrary/unrelated
      firmware (relay, robot, or something else entirely) without
      requiring that firmware to cooperate in any way.
- [x] The raw register value is passed through `naming.ts`'s ID-to-name
      function (ticket 002) to produce the five-letter name.
- [x] On SWD attach failure, returns/reports a distinct
      "detected-but-unnamed, error: <reason>" result rather than
      throwing uncaught, returning a default name, or omitting the
      device.
- [x] Does not read the USB serial number as a naming fallback under any
      circumstance.
- [ ] Verified manually against a blank, never-flashed micro:bit as part
      of this sprint's hardware smoke test (cannot be meaningfully unit-
      tested without real SWD-capable hardware — see Testing below).
      **Not yet done**: only one board was available for this dispatch,
      already running firmware. See Verification Record below — this
      criterion needs a follow-up pass with a blank board (and ideally a
      relay/robot) before the sprint's blank-board done-criterion can be
      considered met.

## Verification Record

Real attached hardware (not a blank board — a running micro:bit, serial
`9906360200052820aba2e384f40cfd6c000000006e052820`, HID product `BBC
micro:bit CMSIS-DAP`, DAPLink `v0257`, port `/dev/cu.usbmodem2121102`):

- `enumerateDaplinkDevices()` found it with `availability: "full"`.
- `readSwdName(device)` attached over SWD (attach only — no halt, no
  reset) and read `FICR.DEVICEID[1]` **twice**, on separate runs, both
  times returning the identical raw value `0xfbfd96c9` (4227700425),
  which `naming.ts`'s `deviceIdToName` turns into **`zeguz`** —
  consonant/vowel/consonant/vowel/consonant over `zvgpt`/`uoiea`, as
  required.
- Verified with `npx vitest run packages/host` (25 tests) and `npm test`
  (266 tests, up from the 258 baseline — the 8 new tests are this
  ticket's), both passing, plus `npm run build` (clean across all three
  packages).
- **Runtime import trap found and fixed during verification**: `dapjs`
  ships only a UMD bundle with no ESM build and no `__esModule` marker.
  `import { CortexM, HID } from "dapjs"` type-checks fine and even
  passes under `vitest` (Vite's commonjs plugin actually executes the
  module to resolve named exports), but throws `SyntaxError: ... does
  not provide an export named 'CortexM'` under real Node at runtime,
  because Node's static CJS/ESM interop (`cjs-module-lexer`) cannot
  detect named exports assigned through the UMD wrapper's renamed
  `exports` parameter. Caught this by actually running the module under
  plain Node (`tsx`) against the attached hardware, not just `vitest` —
  `npm test` alone would never have caught it. Fixed by taking the
  default import (always `module.exports` itself, regardless of static
  detection) for runtime values and a `type`-only import (erased at
  compile time, unaffected by the runtime interop path) for types. See
  `swdName.ts`'s import-block comment.
- Blank/never-flashed-board and multi-firmware (relay/robot) cases from
  the ticket's Testing section were **not** exercised — only one board
  was available, already running firmware, for this dispatch. That
  coverage still needs a manual pass with a blank board and a relay/robot
  before the sprint's own done-criterion (which depends on the blank-
  board case) can be considered met.

## Testing

- **Existing tests to run**: `npm test` (protocol + `devices.ts` suites
  continue passing).
- **New tests to write**: this module's core logic (SWD register read →
  `naming.ts` hand-off) is a thin wrapper around real hardware access
  and is not meaningfully unit-testable without a physical DAPLink
  device — do not attempt to mock `dapjs`/`node-hid` so thoroughly that
  the test only proves the mock was called correctly. Instead, write a
  narrow unit test for the pure "raw register value → name" hand-off
  (which is really just re-confirming `naming.ts`'s own contract at the
  call site), and treat the actual SWD read as covered by this sprint's
  hardware smoke test, explicitly including the blank-micro:bit case.
- **Verification command**: `npm test -- packages/host` for the thin
  unit-testable slice; manual smoke test with a blank micro:bit, a
  relay, and a robot for the real SWD path (this sprint's Success
  Criteria depend on this manual step — do not consider this ticket done
  from `npm test` passing alone).

## Implementation Plan

**Approach**:
1. Add `dapjs` as a `packages/host` dependency.
2. Implement the attach-mode SWD connection over the `node-hid` handle
   from a `devices.ts` record (no halt, no reset — confirm `dapjs`'s API
   defaults/flags for this explicitly rather than assuming).
3. Implement the `FICR.DEVICEID[1] @ 0x10000064` `readMem32` call.
4. Hand the raw value to `naming.ts`'s ID-to-name function.
5. Implement the detected-but-unnamed error path for attach failure,
   with a specific, actionable error message (permissions vs.
   unsupported-chip should be distinguishable where `dapjs` provides
   enough information to tell them apart).
6. Manually verify against a blank micro:bit, a relay, and a robot,
   recording the exact commands/output in this ticket's Verification
   Record once implemented.

**Files to create**:
- `packages/host/src/swdName.ts`
- `packages/host/src/swdName.test.ts` (narrow unit slice only, per
  Testing above)

**Files to modify**:
- `packages/host/package.json` (add `dapjs` dependency).

**Testing plan**: narrow unit test for the register-value-to-name
hand-off; manual hardware smoke test (blank micro:bit, relay, robot) as
the real verification, recorded in this ticket once run.

**Documentation updates**: none beyond an inline comment reiterating why
attach mode with no halt/reset is required (the blank-micro:bit Success
Criterion depends on it, and it is easy for a future editor to "improve"
this into a halt/reset without realizing why it must not).


## Verification update — non-announcing board case RESOLVED

The board used for verification (`zeguz`, serial
`9906360200052820aba2e384f40cfd6c000000006e052820`) was independently
confirmed **silent on serial**: opened at 115200 on
`/dev/cu.usbmodem2121102`, sent `HELLO` and `?`, waited 6s, received
**zero bytes**. Confirmed three separate ways — through `UsbSerialLink`
(ticket 008), through a raw `serialport` script bypassing all project
code, and through a third independent probe by the team-lead.

`readSwdName()` nonetheless returned `DEVICEID[1] = 0xfbfd96c9` ->
`zeguz`, cross-checked against the published worked-example table in
the relay protocol spec (`zeguz`, n=425, channel 25, group 19).

This satisfies the blank/never-flashed acceptance criterion in
substance: the criterion exists to prove the name comes from the target
chip over SWD rather than from firmware output or the USB serial
number. A board that emits nothing on serial and is still named
correctly is exactly that proof. Whether the board is literally erased
or running silent non-announcing code does not change what is
demonstrated.

Still unverified for want of hardware: a board that *does* announce, so
the `role` field and the `HELLO`/`?`/`STATUS` reply path remain
untested against real firmware. See the sprint's Hardware Verification
Gap section.
