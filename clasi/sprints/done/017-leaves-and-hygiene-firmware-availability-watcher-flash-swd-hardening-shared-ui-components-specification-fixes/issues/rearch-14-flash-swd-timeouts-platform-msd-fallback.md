---
status: in-progress
sprint: '017'
tickets:
- 017-003
- 017-004
---

# Flash and SWD naming: timeouts on every DAPLink/HID call, platform-aware MSD fallback, board-owner exclusivity

## Description

`flash.ts`, `swdName.ts`, and `localHexUpload.ts` are clean leaves with
no registry coupling and are kept. Findings
(`03-host-server-flash-releases.md` §2):

- No timeout on `daplink.connect()`, `daplink.flash()`,
  `processor.connect()`, `readMem32()` (`flash.ts:331-333, 452`,
  `swdName.ts:367-368`). A wedged HID transport hangs the board's mutex
  slot forever; `deviceRegistry.ts:2651-2662` acknowledges and defers it.
- MSD fallback is macOS-only: `readdir("/Volumes")` hard-coded
  (`flash.ts:588`). Linux (`/media/$USER`, `/run/media/$USER`) and
  Windows (drive letters + `DETAILS.TXT`) never find a volume, so the
  fallback is silently skipped and the SWD error is final.
- After a `program-failed` attempt the MSD write starts with no settle
  delay, and success is reported as soon as `writeFile` returns while
  DAPLink is still programming (`:697-712`).
- Exclusivity between naming, serial session, flash, and reset is
  enforced only by `deviceRegistry`'s `KeyedMutex`
  (`:2681, :2763, :3090`); once that class is gone (rearch-05) the
  invariant must live in `board_owner`.
- Naming: `flashOverSwd`/`resetOverSwd` are DAPLink vendor-command
  operations, not SWD; the misnomer hides the resource model
  (HID handle, interface-chip reset ⇒ no USB re-enumeration).
- `localHexUpload` cap checks the declared `byteLength` only; set
  `maxPayload` on the `WebSocketServer` (rearch-06) as the real bound.

## Proposed resolution

- Wrap every dapjs call in a `withTimeout(promise, ms, label)`; on
  timeout, disconnect best-effort and return a typed `timeout` failure
  class alongside the existing ones.
- `listVolumeNames(platform)`: darwin `/Volumes`; linux `/media/<user>`,
  `/run/media/<user>`, `/mnt`; win32 enumerate drive letters. Match on
  `DETAILS.TXT` as today. Log (not swallow) enumeration failures.
- MSD path: 500 ms settle before the copy; after `writeFile`, poll for
  the volume to disappear/reappear (DAPLink remounts) up to 10 s before
  reporting `resetting` → done.
- `connect/flasher.ts` (small): acquire `board_owner = 'flash'`
  (waiting for a session owner to release, closing the session first via
  the reconciler), run `flash()`, write `links.flash` phases to the store,
  release, and let the USB watcher's `updated`/`added` event drive
  re-identification instead of `reidentifyAfterFlash`'s copy of the
  connect sequence.
- Rename `flashOverSwd` → `flashViaDapLink`, `resetOverSwd` →
  `resetViaDapLink`; keep `readSwdName` (that one really is SWD).
- Keep the pure hex/manifest/volume functions verbatim.

## Acceptance

- Fake dapjs that never resolves `flash()` → `timeout` failure within the
  configured budget, HID handle closed, `board_owner` released.
- `listVolumeNames` unit tests per platform with a fake `fs`.
- A flash requested while a session is open closes the session first
  (owner handoff visible in the store) and the link returns to
  `connected` after the watcher re-identifies the board.
- Existing `flash.test.ts` cases still pass under the new names.

## Depends on

rearch-01, rearch-02, rearch-05.

## References

- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §2
- `docs/design/architecture.md` §4 (`board_owner`)
