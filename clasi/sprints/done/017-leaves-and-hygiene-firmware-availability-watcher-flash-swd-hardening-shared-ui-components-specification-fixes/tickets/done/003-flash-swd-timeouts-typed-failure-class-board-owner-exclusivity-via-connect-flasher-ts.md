---
id: '003'
title: Flash/SWD timeouts, typed failure class, board_owner exclusivity via connect/flasher.ts
status: done
use-cases:
- SUC-003
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

- [x] Every dapjs call (`daplink.connect()`, `daplink.flash()`,
      `processor.connect()`, `readMem32()`) is wrapped in
      `withTimeout(promise, ms, label)`.
- [x] On timeout, the call disconnects best-effort and returns a typed
      `timeout` failure class alongside the existing failure classes.
- [x] `connect/flasher.ts` acquires `board_owner = 'flash'` (waiting for
      a session owner to release, closing the session first via the
      reconciler if one is open), runs `flash()`, writes `links.flash`
      phases to the store, and releases the owner in a `finally`
      regardless of outcome.
- [x] Re-identification after a flash uses the USB watcher's normal
      `updated`/`added` event; `reidentifyAfterFlash`'s copy of the
      connect sequence is removed.
- [x] `flashOverSwd` is renamed `flashViaDapLink`, `resetOverSwd` is
      renamed `resetViaDapLink`; `readSwdName` keeps its name (it is
      genuinely SWD).
- [x] `localHexUpload`'s payload cap is enforced by `maxPayload` on the
      `WebSocketServer`, not only the declared `byteLength`.
- [x] Fake `dapjs` that never resolves `flash()` → `timeout` failure
      within the configured budget, HID handle closed, `board_owner`
      released.
- [x] A flash requested while a session is open closes the session
      first (owner handoff visible in the store) and the link returns
      to `connected` after the watcher re-identifies the board.
- [x] Existing `flash.test.ts` cases pass under the new names.

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

## Implementation notes

- **`lib/withTimeout.ts`** (new): a small, dependency-free
  `withTimeout(promise, ms, label)` + `TimeoutError` class, shared by
  `flash.ts` and `swdName.ts` so neither has to depend on the other just
  to reuse it. `TimeoutError` carries `label`/`ms` and is
  `instanceof`-checked at every call site, the same "typed, not
  string-matched" precedent `FlashFailure.reason`/`SwdNameFailure.reason`
  already set.
- **`flash.ts`**: `flashOverSwd`→`flashViaDapLink`,
  `resetOverSwd`→`resetViaDapLink` (`readSwdName` untouched, per plan).
  `daplink.connect()`/`daplink.flash()` (and `resetViaDapLink`'s own
  `connect()`/`reset()`) are each wrapped in `withTimeout`, with default
  budgets `DEFAULT_DAPLINK_CONNECT_TIMEOUT_MS` (5s),
  `DEFAULT_DAPLINK_FLASH_TIMEOUT_MS` (30s, generous since a full image
  write can take several seconds), `DEFAULT_DAPLINK_RESET_TIMEOUT_MS`
  (5s) — all overridable per call for tests. A `connect()` timeout
  disconnects best-effort before returning (that call is not covered by
  the function's own `finally`); a `flash()`/`reset()` timeout is
  already covered by the existing `finally`. `FlashFailure.reason` gains
  `"timeout"` and `"owner-unavailable"` (the latter produced only by
  `connect/flasher.ts`, documented in `flash.ts` since both share the
  `FlashOutcome` type). `flash()`'s own `FlashOptions` gained
  `connectTimeoutMs`/`flashTimeoutMs` passthrough fields.
- **`swdName.ts`**: `processor.connect()`/`processor.readMem32()` each
  wrapped in `withTimeout` (`DEFAULT_SWD_CONNECT_TIMEOUT_MS`/
  `DEFAULT_SWD_READ_TIMEOUT_MS`, 3s each, overridable via
  `ReadSwdNameOptions`). The existing `finally` block already disconnects
  regardless of which awaited call failed, so no extra best-effort
  disconnect call was needed at the timeout site itself.
  `SwdNameFailure.reason` gains `"timeout"`.
- **`connect/flasher.ts`** (new) + **`connect/flasher.test.ts`** (new):
  `createFlasher(store, {reconciler, flash?, now?, delay?}, opts?)`
  returns a `Flasher` whose `flash(linkId, usbSerial, device, hexText,
  onProgress, flashOptions?)`: (1) calls `reconciler.requestClose(linkId)`
  unconditionally (a no-op via `planUserClose` if nothing is open/
  opening); (2) acquires `board_owner = 'flash'` for `usbSerial`,
  retrying on a short poll (`DEFAULT_ACQUIRE_TIMEOUT_MS` 5s /
  `DEFAULT_ACQUIRE_POLL_MS` 100ms, both overridable) since
  `connect/connector.ts`'s own contract means a session does not itself
  hold `board_owner` past its connect attempt — the retry only has to
  cover a residual concurrent-attempt race, not the common case; (3)
  calls `flash()` (the injected `flash.ts#flash` by default) and
  forwards its `onProgress` phase callback unchanged (`links.flash`'s
  ephemeral overlay is `server.ts`'s own responsibility, per
  `projection.ts`'s doc comment — this module just keeps the callback
  flowing through); (4) releases the owner in a `finally` regardless of
  outcome, success, failure, or an unexpected rejection. `reconciler` is
  typed as a narrow structural `FlasherSessionCloser` (one method)
  defined in this module itself, mirroring `connector.ts`'s own
  `HarvesterAttach` seam — this module never imports
  `connect/reconciler.ts`, matching `sprint.md`'s own stated dependency
  direction ("`connect/flasher.ts` depends on `store` and `flash.ts`").
  A never-acquired owner returns `{status: "error", reason:
  "owner-unavailable"}` rather than hanging forever. Tests use a real,
  in-memory (`:memory:`) `Store`, per `sprint.md`'s own Design
  Rationale ("the same kind of fake-store table tests the reconciler and
  connector already use").
- **`server.ts`**: `flash-start`/`flash-local-*` orchestration
  (`runFlashTask`) now calls `flasher.flash(linkId, usbSerial, device,
  hexText, onProgress)` instead of calling the injected `flash` function
  directly; the `flasher` instance wraps that same injectable `flash`
  seam (`options.flash`), so every existing `server.test.ts` fixture
  that injects a fake `flash` kept working unmodified. `DEFAULT_MAX_
  PAYLOAD_BYTES` is now computed as `MAX_UPLOAD_BYTE_LENGTH +
  UPLOAD_ID_BYTE_LENGTH + 4096` (imported from `localHexUpload.ts`/
  `wsMessages.ts`) instead of a separately-chosen `8 * 1024 * 1024`
  literal that merely happened to be larger — tying `WebSocketServer`'s
  own `maxPayload` directly to the real upload cap per review finding F9.
- **Tests added**: `lib/withTimeout.test.ts` (new, pure helper),
  `connect/flasher.test.ts` (new, 8 cases), timeout cases added to
  `flash.test.ts` (`flashViaDapLink`×2, `resetViaDapLink`×1, `flash()`×1)
  and `swdName.test.ts` (`readSwdName`×2), plus two new `server.test.ts`
  cases: one tying `DEFAULT_MAX_PAYLOAD_BYTES` to the upload cap, one
  exercising the full close-first / board_owner-visible-in-store /
  release-after handoff through the real WebSocket command path.
- **Deviation from the plan's file list**: no changes were needed to
  `localHexUpload.ts` itself — its `receiveFrame` already checked the
  actual payload length against the declared `byteLength` before
  hashing; the real gap (per finding F9) was that `server.ts`'s own
  `maxPayload` was a coincidentally-larger magic number rather than
  being tied to that cap, which is what this ticket's `server.ts` change
  fixes.
- Verified `reidentifyAfterFlash` no longer exists anywhere in the
  codebase (only mentioned in historical doc comments) — sprint 015
  ticket 005's server.ts rewrite already retired it; this ticket's AC 4
  needed no further code change, just confirmation.
