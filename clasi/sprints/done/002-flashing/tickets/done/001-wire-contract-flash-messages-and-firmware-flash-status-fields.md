---
id: '001'
title: 'Wire contract: flash messages and firmware/flash-status fields'
status: done
use-cases: []
depends-on: []
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Wire contract: flash messages and firmware/flash-status fields

## Description

Extend `packages/host/src/wsMessages.ts` — the one shared WS contract
between `server.ts` and the UI — with the shapes this whole sprint
builds on. Every later ticket (002–007) imports `FirmwareKind` and/or
the new message/field types from this ticket, so it goes first. See
`sprint.md`'s Architecture, Step 5, "`wsMessages.ts`" for the exact
shapes; this ticket implements them.

No behavior changes to `server.ts`, `deviceRegistry.ts`, or the UI in
this ticket — purely the shared type/shape layer plus its own
parse/narrow unit tests, matching how `wsMessages.test.ts` already
covers `open`/`close`/`line`.

## Acceptance Criteria

- [x] `FirmwareKind = "relay" | "robot"` and `FlashPhase` (at minimum:
      `"fetching" | "verifying" | "erasing" | "writing" | "resetting"`)
      are exported.
- [x] `FlashStartMessage { type: "flash-start"; deviceId: string;
      firmware: FirmwareKind }` is added to `ClientMessage`, and
      `parseClientMessage` validates and narrows it (non-empty
      `deviceId`, `firmware` one of the two literal values) the same
      way `open`/`close` already are.
- [x] `FlashProgressMessage { type: "flash-progress"; deviceId;
      firmware: FirmwareKind; phase: FlashPhase }` and
      `FlashResultMessage { type: "flash-result"; deviceId; firmware:
      FirmwareKind; status: "ok" | "error"; message?: string }` are
      added to `ServerMessage`.
- [x] `DeviceListEntry` gains `flashStatus?: { firmware: FirmwareKind;
      phase: FlashPhase }`, documented (per the file's existing doc-comment
      style) as present only while a flash is in flight for that device.
- [x] `DevicesMessage` gains `firmwareStatus: Record<FirmwareKind,
      FirmwareAvailability>` where `FirmwareAvailability = { configured:
      false } | { configured: true; repoUrl: string; tag: string;
      available: boolean; reason?: string }`.
- [x] Existing message shapes (`DevicesMessage`'s existing fields,
      `LineMessage`, `OpenDeviceMessage`, `CloseDeviceMessage`,
      `ErrorMessage`) are unchanged — this is purely additive.
- [x] `wsMessages.test.ts` gains parse/narrow tests for `flash-start`
      (valid, missing `deviceId`, invalid `firmware` value, missing
      `firmware`) mirroring the existing `open`/`close` test shape.

## Implementation Plan

**Approach**: Add the new types and extend the two discriminated
unions and `parseClientMessage`'s `switch`. No new files.

**Files to modify**:
- `packages/host/src/wsMessages.ts`
- `packages/host/src/wsMessages.test.ts`

**Testing plan**: Unit tests only (this module has zero I/O). Cover:
valid `flash-start` round-trips through `parseClientMessage`; missing/
empty `deviceId` rejected; a `firmware` value outside the two literals
rejected; the new optional fields don't break parsing of an object that
predates them (a `DeviceListEntry`-shaped fixture without `flashStatus`
still round-trips as valid `DeviceListEntry` since the field is
optional — assert via a type-level fixture, not a runtime parser, since
`DeviceListEntry`/`DevicesMessage` are server->client only and have no
narrowing function of their own today).

**Documentation updates**: Update the module's own doc comment (the
"Direction" section) to list the three new message shapes alongside the
existing ones.

## Implementation Notes

`DevicesMessage.firmwareStatus` is required (not optional), per this
ticket's own spec and the sprint's full-snapshot philosophy. That makes
`npm run build`'s whole-repo `tsc --noEmit` fail in `server.ts` (2
errors: its two `{ type: "devices", devices }` constructions no longer
satisfy `ServerMessage`, missing `firmwareStatus`) until ticket 006
("server.ts and cli.ts: wire flash requests, progress broadcast,
firmware status") populates it. This is expected and intentional, not a
regression from this ticket's work — this ticket's own scope explicitly
excludes behavior changes to `server.ts`, and ticket 006 is the one that
owns wiring `firmwareStatus` into the broadcast. `wsMessages.ts` and
`wsMessages.test.ts` themselves typecheck cleanly in isolation; the only
`tsc` errors anywhere in the repo are the two in `server.ts` described
above. Flagging here so the sprint isn't closed before ticket 006 lands.
