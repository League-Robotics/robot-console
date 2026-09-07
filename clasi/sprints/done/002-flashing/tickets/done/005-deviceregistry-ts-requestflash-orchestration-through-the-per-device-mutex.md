---
id: '005'
title: 'deviceRegistry.ts: requestFlash orchestration through the per-device mutex'
status: done
use-cases: []
depends-on:
- '001'
- '002'
- '003'
- '004'
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# deviceRegistry.ts: requestFlash orchestration through the per-device mutex

## Description

Wire `deviceRegistry.ts` to orchestrate a flash: `config.ts` (which
firmware source) → `releases.ts` (fetch+verify hex) → `flash.ts` (write
it), all as one more operation run through the existing per-device
`KeyedMutex` — the same mechanism that already serializes
`requestOpen`/`requestClose`/`sendLine`/name resolution. This is the
module `sprint.md`'s architecture designates as the sole thing aware of
all three new modules together (see Design Rationale's fan-out
justification) — no new synchronization primitive, no new module in
between.

This directly addresses the sprint's SWD-contention constraint and
narrows (without fully resolving — see Design Rationale) the still-open
`port-lock-contention-between-identify-and-user-open.md` issue: a flash
can never run concurrently with an identify/open/close on the same
device, because all four go through the same mutex key.

## Acceptance Criteria

- [x] `DeviceRegistry.requestFlash(deviceId: string, firmware:
      FirmwareKind): Promise<void>` runs via `this.mutex.run(deviceId,
      ...)`, exactly like the existing `requestOpen`/`requestClose`.
- [x] The flash task, in order: (a) tears down any open link via the
      existing `teardownLink`; (b) looks up the `FirmwareSource` for
      `firmware` via injected `getFirmwareConfig`-shaped config; (c)
      calls `releases.ts` to resolve+fetch+verify, emitting a
      flash-progress event per phase (`"fetching"`, `"verifying"`); (d)
      calls `flash.ts` to write it, emitting `"erasing"`/`"writing"`/
      `"resetting"`; (e) on success, calls the existing `openLink` once
      more to pick up the newly-flashed firmware's banner without a
      separate manual Connect click.
- [x] `DeviceState` gains `flashStatus?: { firmware: FirmwareKind;
      phase: FlashPhase }`, set at the start of the flash task and
      cleared (success or error) at the end; `toEntry` reflects it into
      `DeviceListEntry.flashStatus`.
- [x] A `requestFlash` call for an unknown `deviceId` reports via the
      existing `onError`/`emitError` path, matching `requestOpen`'s own
      unknown-device handling — never thrown to the caller.
- [x] A firmware source with no configured value (per ticket 002's
      "absent variable" case), or a `releases.ts`/`flash.ts` failure at
      any stage, ends the flash with a `flash-result` `status: "error"`
      event and a cleared `flashStatus` — never a hung/never-cleared
      `flashStatus`.
- [x] New `DeviceRegistry` event surfaces: `onFlashProgress(listener)`
      and `onFlashResult(listener)`, mirroring the existing
      `onDevicesChanged`/`onLine`/`onError` subscribe/unsubscribe shape.
- [x] A test asserts that a `requestOpen`/name-resolution call and a
      `requestFlash` call issued back-to-back for the same device
      execute in call order, never interleaved (the core mutex
      guarantee this ticket relies on) — using the same injectable
      fakes (`resolveName`, `createLink`) `deviceRegistry.test.ts`
      already uses, plus new injectable fakes for config/releases/flash.
- [x] No change to the existing attach/detach flow's behavior or to
      `requestOpen`/`requestClose`/`sendLine`'s existing test coverage.

## Implementation Plan

**Approach**: Add `getFirmwareConfig`, `resolveRelease`+
`fetchAndVerifyHex`, and `flash` as injectable `DeviceRegistryOptions`
fields (defaulting to the real implementations from tickets 002-004),
following this file's existing injection pattern
(`resolveName`/`createLink`) exactly, so `deviceRegistry.test.ts` can
substitute fully synthetic fakes for all three with no real network/
USB/filesystem I/O — matching this file's own "never test against real
hardware" precedent.

**Files to modify**:
- `packages/host/src/deviceRegistry.ts`
- `packages/host/src/deviceRegistry.test.ts`

**Testing plan**: Extend the existing fake-driven test suite: a
successful flash (fetch ok, write ok) drives `flashStatus`/progress/
result through the expected sequence and re-opens the link afterward; a
fetch failure and a write failure each end in a `flash-result` error
with `flashStatus` cleared; a `requestFlash` racing an in-flight
`requestOpen`/name-resolution on the same device serializes correctly
(mutex ordering assertion); an unconfigured firmware source ends in an
error result without ever calling `releases.ts`/`flash.ts`.

**Documentation updates**: Update the module's own doc comment (the
"attach flow" section) to describe flashing's place in the mutex
ordering, and reference this ticket's re-open-after-flash behavior
next to the existing detach-flow discussion.
