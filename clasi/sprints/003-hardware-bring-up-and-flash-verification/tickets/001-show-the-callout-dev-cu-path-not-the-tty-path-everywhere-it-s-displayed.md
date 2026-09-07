---
id: '001'
title: Show the callout (/dev/cu.*) path, not the tty path, everywhere it's displayed
status: in-progress
use-cases:
- SUC-003
depends-on: []
github-issue: ''
issue: device-list-shows-tty-path-not-cu-path.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Show the callout (/dev/cu.*) path, not the tty path, everywhere it's displayed

## Description

`packages/host/src/devices.ts` reports the raw `/dev/tty.*` path `serialport`
gives it. `packages/host/src/link/UsbSerialLink.ts` already knows this is
wrong for opening a port on macOS — it privately translates to `/dev/cu.*`
via its own `toCalloutPath` before opening — but that translated value never
reaches `devices.ts`'s `SerialPortInfo.path`, so `deviceRegistry.ts`'s
`toEntry()` (line ~165) and its `linkError`/`openLink` path (line ~620) both
surface the tty path verbatim to the UI. A user who copies that path into a
terminal will hang waiting for DCD.

Per sprint.md's Architecture ("Design Rationale" — consolidate
`toCalloutPath`), fix this at the source: move the translation into
`devices.ts` so every consumer (the Devices tab, `linkError` text) agrees,
rather than only the one call site that happens to open the port.

## Acceptance Criteria

- [x] provable-without-hardware: `toCalloutPath` (moved to `devices.ts`) is
      unit-tested for: darwin tty→cu translation, darwin cu passthrough
      (already-correct path unchanged), darwin non-DAPLink-shaped path
      passthrough, and non-darwin (e.g. linux) passthrough — the same cases
      `UsbSerialLink.test.ts`'s existing `describe("toCalloutPath", ...)`
      suite already covers.
- [x] provable-without-hardware: `joinDaplinkDevices`'s unit tests confirm
      `SerialPortInfo.path` is the *translated* (cu) path on a synthetic
      darwin-shaped fixture, not the raw `serialport`-reported path.
- [x] provable-without-hardware: `UsbSerialLink.test.ts` still passes with
      `toCalloutPath` imported from `../devices.js`; `UsbSerialLink.open()`'s
      behavior is unchanged (it still calls `toCalloutPath(this.portPath)` —
      now a defensive no-op on an already-translated path, not the only
      place translation happens).
- [ ] needs-a-board: the Devices tab shows `/dev/cu.usbmodemXXXX` (not
      `/dev/tty.usbmodemXXXX`) for an attached board, confirmed against a
      real port path. Record pass/fail — do not infer from the unit tests.
      NOT YET VERIFIED — no board attached in this session. Deferred to
      ticket 005's bench session, which exercises this exact code path
      with real hardware.
- [x] `npm run build` passes (three workspaces, no type errors from the
      moved export).

## Implementation Plan

**Approach:** move, don't duplicate. `devices.ts` already owns
`SerialPortInfo.path` and has zero outward host-module dependencies of its
own (only `node-hid`/`serialport`), making it a safe, non-cyclic home for
the canonical translation. `link/UsbSerialLink.ts` becomes a consumer of
`devices.ts`, not the other way around — this is the one new intra-package
import edge this sprint introduces (see sprint.md's Architecture section
for the full rationale and the alternatives rejected).

1. Move `toCalloutPath`, `DARWIN_TTY_PREFIX`, `DARWIN_CU_PREFIX` from
   `packages/host/src/link/UsbSerialLink.ts` (currently lines ~72-101) into
   `packages/host/src/devices.ts`, exported with the same name and
   signature (`toCalloutPath(path: string, platform?: NodeJS.Platform):
   string`).
2. In `devices.ts`'s `joinDaplinkDevices`, when constructing each
   `SerialPortInfo`, wrap `entry.serialPort.path` with `toCalloutPath(...)`
   so the stored `path` is always the callout/open-safe path.
3. In `link/UsbSerialLink.ts`, replace the local definition with
   `import { toCalloutPath } from "../devices.js"`. Leave the call site in
   `open()` (`const calloutPath = toCalloutPath(this.portPath);`) unchanged
   — this is deliberate defense-in-depth (correct even if a caller ever
   constructs a link directly from a raw path), not the only correctness
   mechanism now.
4. Move (or duplicate with a comment explaining why both exist)
   `UsbSerialLink.test.ts`'s `describe("toCalloutPath", ...)` suite's cases
   into `devices.test.ts`, importing from `../devices.js` in both files.
5. Add a `joinDaplinkDevices` test case with a synthetic darwin-shaped
   `serialport` listing (`path: "/dev/tty.usbmodemXXXX"`) asserting the
   resulting `DaplinkDevice.serialPort.path` is the `/dev/cu.*` form.
6. No change expected in `deviceRegistry.ts` or `packages/ui` — they
   already just read `serialPort.path` / `entry.port` verbatim (confirmed
   during planning at `deviceRegistry.ts:165` and `:620`,
   `DevicesTab.tsx:270`/`:291`).

**Files to modify:**
- `packages/host/src/devices.ts`
- `packages/host/src/link/UsbSerialLink.ts`
- `packages/host/src/devices.test.ts`
- `packages/host/src/link/UsbSerialLink.test.ts`

**Testing plan:** `npm test -- packages/host` (scoped — this ticket touches
only `packages/host`), then `npm run build`. The full suite runs once at
`close_sprint`, not per ticket.

**Documentation updates:** none beyond code comments already documenting
this move — sprint.md's Architecture section is the design record.
