---
id: '003'
title: Flash/SWD timeouts, typed failure class, board_owner exclusivity via connect/flasher.ts
status: open
use-cases: [SUC-003]
depends-on: []
github-issue: ''
issue: rearch-14-flash-swd-timeouts-platform-msd-fallback.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Flash/SWD timeouts, typed failure class, board_owner exclusivity via connect/flasher.ts

## Description

No DAPLink/HID call in the flash/naming path has a timeout today
(`daplink.connect()`, `daplink.flash()`, `processor.connect()`,
`readMem32()`), so a wedged transport hangs the board's mutex slot
forever. Exclusivity between naming, session, and flash was enforced
by `deviceRegistry.ts`'s `KeyedMutex`, which is gone (rearch-05); the
invariant must live in `board_owner`. This ticket wraps every dapjs
call in a timeout with a typed failure class, adds a small
`connect/flasher.ts` orchestrator that owns `board_owner` acquisition
and session close-first handoff around a flash operation (keeping
`flash.ts` itself free of store coupling), and renames the
DAPLink-vendor-command operations that were misleadingly called "SWD"
(`flashOverSwd`→`flashViaDapLink`, `resetOverSwd`→`resetViaDapLink`).
Platform-aware MSD fallback is ticket 004, split out because it is an
independently testable failure mode (fake `fs` vs. fake `dapjs`).

## Acceptance Criteria

- [ ] Every dapjs call (`daplink.connect()`, `daplink.flash()`,
      `processor.connect()`, `readMem32()`) is wrapped in
      `withTimeout(promise, ms, label)`.
- [ ] On timeout, the call disconnects best-effort and returns a typed
      `timeout` failure class alongside the existing failure classes.
- [ ] `connect/flasher.ts` acquires `board_owner = 'flash'` (waiting for
      a session owner to release, closing the session first via the
      reconciler if one is open), runs `flash()`, writes `links.flash`
      phases to the store, and releases the owner in a `finally`
      regardless of outcome.
- [ ] Re-identification after a flash uses the USB watcher's normal
      `updated`/`added` event; `reidentifyAfterFlash`'s copy of the
      connect sequence is removed.
- [ ] `flashOverSwd` is renamed `flashViaDapLink`, `resetOverSwd` is
      renamed `resetViaDapLink`; `readSwdName` keeps its name (it is
      genuinely SWD).
- [ ] `localHexUpload`'s payload cap is enforced by `maxPayload` on the
      `WebSocketServer`, not only the declared `byteLength`.
- [ ] Fake `dapjs` that never resolves `flash()` → `timeout` failure
      within the configured budget, HID handle closed, `board_owner`
      released.
- [ ] A flash requested while a session is open closes the session
      first (owner handoff visible in the store) and the link returns
      to `connected` after the watcher re-identifies the board.
- [ ] Existing `flash.test.ts` cases pass under the new names.

## Implementation Plan

**Approach**: Add a `withTimeout` helper (small, local to `flash.ts` or
a shared `lib/withTimeout.ts` if `swdName.ts` needs it too) and a typed
`TimeoutFailure` class beside the existing failure classes. Add
`connect/flasher.ts` modeled on `connect/connector.ts`'s shape
(acquire owner → do the thing → release), reusing `board_owner`
acquisition helpers the connector already has. Do the renames as a
follow-up pass within the same ticket since they touch the same call
sites.

**Files to create**:
- `packages/host/src/connect/flasher.ts`
- `packages/host/src/connect/flasher.test.ts`

**Files to modify**:
- `packages/host/src/flash.ts` — timeouts, typed failure class,
  renames; remove `reidentifyAfterFlash`.
- `packages/host/src/swdName.ts` — timeout on `readMem32()`/
  `processor.connect()`; keep `readSwdName` name.
- `packages/host/src/localHexUpload.ts` — real `maxPayload` bound.
- `packages/host/src/flash.test.ts` — update to new names, add timeout
  cases.
- `packages/host/src/server.ts` (or wherever flash requests are
  dispatched) — route through `connect/flasher.ts` instead of calling
  `flash.ts` directly.

**Testing plan** (scoped vitest run: `connect/flasher.test.ts`,
`flash.test.ts`, `swdName.test.ts`):
- Fake `dapjs` never resolving `flash()`/`connect()` → timeout failure,
  handle closed, owner released.
- Flash requested while a session is open → session closes first
  (assert via store fixture), flash proceeds, board re-identified via
  watcher event afterward.
- Existing flash success/failure-class cases re-verified under new
  names.

**Documentation updates**: None beyond code comments; `architecture.md`
§8 already describes `board_owner`-based exclusivity in general terms
and needs no sprint-level update.
