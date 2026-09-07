---
id: '006'
title: 'server.ts and cli.ts: wire flash requests, progress broadcast, firmware status'
status: open
use-cases: []
depends-on: ["001", "002", "003", "005"]
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# server.ts and cli.ts: wire flash requests, progress broadcast, firmware status

## Description

Compose ticket 005's `DeviceRegistry.requestFlash`/flash-progress/
flash-result events and ticket 003's `FirmwareAvailabilityCache` into
actual WebSocket traffic, per `wsMessages.ts`'s contract from ticket
001. `server.ts` gains no new logic of its own here — per its own
module doc comment, it only composes already-computed things into
`ServerMessage` shapes, exactly as it already does for `devices`/
`line`/`error`. `cli.ts` gains the one call that threads
`config.ts`'s startup values through to `server.ts`.

## Acceptance Criteria

- [ ] `server.ts`'s `ws.on("message", ...)` switch gains a
      `"flash-start"` case calling `registry.requestFlash(deviceId,
      firmware)` — added alongside, not interleaved into, the existing
      `open`/`close`/`line` cases.
- [ ] `registry.onFlashProgress`/`onFlashResult` (ticket 005) are
      subscribed at server startup and broadcast as `flash-progress`/
      `flash-result` `ServerMessage`s to every connected client (not
      just the requester) — a flash in progress must be visible to a
      second connected tab too.
- [ ] `startServer` accepts an injectable `firmwareConfig`
      (`FirmwareConfigMap`, from ticket 002) and constructs one
      `FirmwareAvailabilityCache` (ticket 003) from it, started
      alongside `registry.start()` and stopped alongside
      `registry.stop()` in `close()`.
- [ ] Every `devices` broadcast (both the on-connect snapshot send and
      every subsequent `registry.onDevicesChanged` broadcast) includes
      `firmwareStatus` built from the cache's `current()` — merging two
      already-computed values, not new logic.
- [ ] The availability cache's own `onChange` triggers a fresh `devices`
      broadcast (current device snapshot + updated `firmwareStatus`),
      so a client sees the robot-firmware button flip to enabled
      without reconnecting, once the poll detects a release.
- [ ] `cli.ts`'s `main()` calls `getFirmwareConfig()` (ticket 002) and
      passes the result into `startServer`'s options, alongside the
      existing `--port`/`ROBOT_CONSOLE_PORT` resolution; existing
      argv/env parsing and browser-open behavior are unchanged.
- [ ] No change to `server.ts`'s existing `open`/`close`/`line`
      handling, its `wss`/`clients` bookkeeping, or its port-busy error
      handling.
- [ ] `server.test.ts` gains coverage for: a `flash-start` message
      reaching `registry.requestFlash` with the right args; a
      `flash-progress`/`flash-result` event from the registry reaching
      every connected fake client; `firmwareStatus` appearing in a
      `devices` broadcast built from a fake `FirmwareAvailabilityCache`.

## Implementation Plan

**Approach**: Mirror the existing `unsubscribeDevices`/`unsubscribeLine`/
`unsubscribeError` pattern in `startServer` for the two new event
subscriptions; mirror the existing `registry` constructor-injection
option for the new `firmwareConfig`/cache construction, so
`server.test.ts` can inject a fake `FirmwareAvailabilityCache` the same
way it already injects a fake-backed `DeviceRegistry`.

**Files to modify**:
- `packages/host/src/server.ts`
- `packages/host/src/server.test.ts`
- `packages/host/src/cli.ts`

**Testing plan**: Extend `server.test.ts`'s existing fake-`WebSocket`/
fake-`DeviceRegistry` harness with a fake `FirmwareAvailabilityCache`
and fake flash-progress/flash-result emitters; assert broadcast fan-out
to multiple connected fake clients (this already has precedent for
`devices`/`line`/`error` broadcasts in the existing suite). No new test
needed in `cli.ts` beyond confirming `getFirmwareConfig()` is called
and its result forwarded — `cli.ts` has no existing test file; keep
this addition equally light rather than introducing heavier test
infrastructure for a thin wiring change.

**Documentation updates**: `server.ts`'s module doc comment gains one
sentence noting flash traffic and firmware-status composition join the
same WebSocket, consistent with how it already notes telemetry frames
will join in sprint 4.
