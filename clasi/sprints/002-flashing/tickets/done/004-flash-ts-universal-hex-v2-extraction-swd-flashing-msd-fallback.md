---
id: '004'
title: 'flash.ts: universal-hex v2 extraction, SWD flashing, MSD fallback'
status: done
use-cases: []
depends-on:
- '001'
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# flash.ts: universal-hex v2 extraction, SWD flashing, MSD fallback

## Description

Implement `packages/host/src/flash.ts` (`specification.md` §4.5): take
hex bytes and a `DaplinkDevice` (from `devices.ts`) and write the
firmware to the board. Three parts, each independently testable per
`sprint.md`'s architecture: (1) pure universal-hex v2 extraction, no
I/O; (2) SWD flashing via DAPjs over the same `node-hid` CMSIS-DAP
handle `swdName.ts` uses, this time permitted to halt/reset the target
(unlike `swdName.ts`'s deliberate attach-only contract — do not copy
that constraint here, it does not apply to flashing); (3) MSD
volume-copy fallback, used only when SWD flashing itself fails to
attach/program.

This module knows nothing about GitHub or config (per `sprint.md`'s
module-boundary decision) — it only ever receives already-fetched,
already-verified hex bytes from whatever calls it (ticket 005).

## Acceptance Criteria

- [x] `isUniversalHex(hexText: string): boolean` and
      `extractV2Hex(hexText: string): string` are ported from
      `microbit-console/client/src/lib/universal-hex.ts`'s
      `BLOCK_ID_V2 = 0x9903` logic (string-based, adapted from that
      file's `ArrayBuffer`-based original to plain strings/`Buffer`,
      consistent with this module's own I/O boundary).
- [x] `extractV2Hex` is unit tested against known-good universal-hex
      sample data (construct a minimal synthetic universal hex fixture
      with both a v1 and a v2 block; assert only the v2 block's lines
      survive extraction, with a valid EOF record). Non-universal
      (plain Intel hex) input is returned unchanged.
- [x] `flashOverSwd(device: DaplinkDevice, hex: string, onProgress:
      (phase: FlashPhase) => void): Promise<FlashOutcome>` uses DAPjs's
      target-programming API against `device.hid.path`, reporting
      `"erasing"`, `"writing"`, `"resetting"` phases via `onProgress`.
      Not unit-tested against real hardware (no board available this
      sprint — see the sprint's hardware-verification constraint); its
      injectable DAPjs/HID factory seam is unit tested for
      wiring/error-propagation only (mirrors `swdName.ts`'s own
      `CortexMFactory` injection seam and its "not unit-tested against
      a mock beyond the seam itself" precedent). Deferred hardware
      verification: real DAPLink attach/erase/write/reset behavior,
      progress-event timing/granularity against a real slow write.
- [x] `flashViaMsd(volumePath: string, hex: Buffer): Promise<void>`
      writes hex bytes to the mounted volume path, following
      `radio_relay/scripts/flash-local.js`'s write pattern. Unit tested
      against a fake/injectable filesystem write, not a real mounted
      volume. Deferred hardware verification: a real mounted MSD volume,
      and the volume-to-device matching heuristic across multiple
      attached boards (`sprint.md` Step 7 open question).
- [x] `flash(device, hex, onProgress): Promise<FlashOutcome>`
      orchestrates: try `flashOverSwd`; on an attach/program failure
      (not on a successful-but-slow write), fall back to
      `flashViaMsd` if a volume can be resolved for this device, else
      return the SWD failure as the final result. `FlashOutcome`
      includes `method: "swd" | "msd"` for logging (not part of the
      wire contract — see `sprint.md`'s "no leak" note).
- [x] Every function resolves (never throws) on a failure it can
      classify, matching this codebase's "failure is a value"
      convention. (`flashViaMsd` is the one documented exception —
      see its doc comment — but `flash`, its only caller, absorbs any
      thrown error into a classified `FlashOutcome`, so the convention
      holds at every exported orchestration boundary.)

## Implementation Plan

**Approach**: Keep the pure extraction functions free of any DAPjs/
node-hid/fs import so they remain trivially unit-testable (this is the
one part of this module with no hardware dependency at all, same as
`swdName.ts`'s `swdNameResultFromDeviceId` split). Structure
`flashOverSwd`/`flashViaMsd`/`flash` with injectable factories
(`createDapLink`, `writeFile`) the way `swdName.ts` injects
`CortexMFactory` and `UsbSerialLink` injects `createPort`.

**Files to create**:
- `packages/host/src/flash.ts`
- `packages/host/src/flash.test.ts`

**Testing plan**: Full unit coverage for `isUniversalHex`/
`extractV2Hex` against synthetic fixtures. Seam-level tests for
`flashOverSwd`/`flashViaMsd`/`flash`'s orchestration logic (which path
runs when, progress callback sequencing, fallback trigger condition)
using injected fakes — explicitly not a claim of real-hardware
correctness; note in the test file's own doc comment (matching
`swdName.ts`'s precedent) that end-to-end SWD/MSD behavior is deferred
hardware verification per this sprint's known gap.

**Documentation updates**: Module doc comment stating the
attach-and-may-halt contract explicitly, contrasted with
`swdName.ts`'s attach-only contract, so a future reader does not
"fix" one module by copying the other's constraint.
