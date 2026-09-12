---
id: '004'
title: Snapshot/Notice wire contract and buildSnapshot projection
status: done
use-cases:
- SUC-005
depends-on:
- '003'
github-issue: ''
issue: rearch-06-snapshot-wire-contract-and-thin-server.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Snapshot/Notice wire contract and buildSnapshot projection

## Description

Replace `wsMessages.ts`'s `EndpointsMessage`/`EndpointListEntry` and the
per-endpoint flash/WiFi side channels with the `Snapshot`/`Notice` types
from `architecture.md` §9:

- `wsMessages.ts`: define `Snapshot` (`devices[]`, `unassigned[]`,
  `relays[]`, `firmware`, `wifi`, `tasks`, `seq`, `at`) and `Notice`
  (`level`, `linkId?`, `text`, `at`). Link ids are opaque — never parsed
  by the UI. Every server message gains `seq`. `session-open` takes
  `{linkId}` or `{relayLinkId, name}`; the `radio: {}` argument is
  removed (ticket 006 adds `set-radio-override`).
  `forget-known-robot` → `forget-device {deviceId}`. Keep `line`,
  `telemetry`, `flash-*`, `flash-local-*`, `wifi-*`, `send-command`, and
  `parseClientMessage`'s validator style unchanged.
- `packages/host/src/projection.ts`: `buildSnapshot(store): Snapshot`
  built on sprint 014's `Store.snapshotRows()`. Hides `wifi`/`mbserial`
  links of un-owned devices; lists un-named USB boards under
  `unassigned`; derives per-link `capabilities`
  (`open`/`close`/`flash`/`provisionWifi`); fills `relays[].lease`/
  `bridging`; `lastChecked` from the newest `sightings` row for that
  device.

This ticket does not touch `server.ts` (ticket 005) — it only produces
the types and the pure projection function, tested against seeded store
rows with no server/socket involved.

## Acceptance Criteria

- [x] Golden test: seeded rows → `buildSnapshot()` equals a checked-in
      JSON fixture covering an owned robot with USB+WiFi+radio links, an
      un-owned WiFi robot (absent from the output), an unnamed USB board
      (`unassigned`), and a relay under a sweep lease.
- [x] `capabilities` on each link row correctly reflects
      open/close/flash/provisionWifi eligibility for that link's state
      and transport.
- [x] `grep -rn "EndpointListEntry\|rememberedRobots\|discoveredServices" packages/host/src` returns nothing (server.ts/cli.ts are expected to still fail to compile until ticket 005 — see that ticket's note).
- [x] `session-open`'s wire type accepts `{linkId}` or `{relayLinkId, name}` and no longer accepts a `radio` field.
- [x] `forget-known-robot` no longer exists in `wsMessages.ts`; `forget-device {deviceId}` does.

## Implementation Plan

**Approach**: Types first (`wsMessages.ts`), then the pure projection
function against those types. No I/O beyond reading the store.

**Files to create**:
- `packages/host/src/projection.ts`
- `packages/host/src/projection.test.ts`
- `packages/host/src/projection.fixtures/*.json` (golden snapshot
  fixtures)

**Files to modify**:
- `packages/host/src/wsMessages.ts`: replace `EndpointsMessage`/
  `EndpointListEntry` and side-channel types with `Snapshot`/`Notice`;
  update `ClientMessage`'s `session-open`/`forget-known-robot`.

**Testing plan**:
- Unit: golden-snapshot test plus capability-derivation edge cases
  (owned/un-owned, unassigned, relay lease states).
- Run: `npx vitest run packages/host/src/projection.test.ts packages/host/src/wsMessages.test.ts` (if the latter exists; otherwise add type-level assertions).

**Documentation updates**: none — `architecture.md` §9 already documents
this shape; no drift to reconcile.

## Implementation Notes

- `wsMessages.ts` fully replaced `EndpointsMessage`/`EndpointListEntry`
  and the flash/WiFi side channels with `Snapshot`/`Notice`, per
  architecture.md §9. Every `endpointId` field was renamed `linkId`
  throughout (matching ticket 008's own UI-side rename), since the
  "endpoint" vocabulary has no referent left once links are the only
  addressable identity. Kept unchanged (existing callers depend on
  these verbatim): `FirmwareKind`, `FirmwareSourceRef`, `FlashPhase`,
  `FirmwareAvailability`, `RobotStatus`/`RobotFunction` (imported
  directly by `connect/harvester.ts`), `UPLOAD_ID_BYTE_LENGTH`.
- `projection.ts`'s `buildSnapshot(store, seq, at)` takes `seq`/`at` as
  parameters rather than deriving them internally, so the function stays
  a pure `(rows) -> Snapshot` map with no wall-clock read and no
  broadcast-counter bookkeeping of its own — `server.ts` (ticket 005) is
  expected to own both. `SnapshotLink.flash`/`SnapshotRelay.bridging` are
  typed but never populated by this function (no backing store table);
  ticket 005's server overlays them.
- Added `Store.projectionRows()` (with its own test coverage in
  `store/index.test.ts`) as the typed read `buildSnapshot` needs —
  deliberately not an extension of `snapshotRows()`, since
  `store/index.test.ts`'s own doc comment states that method
  intentionally excludes `sightings`/`board_owner`/`relay_leases`/
  `firmware`. Mirrors the existing `reconcilerRows()` precedent (a
  second, purpose-built typed read model alongside `snapshotRows()`).
- An un-owned WiFi/mbserial robot is dropped from `devices[]` entirely
  (not shown as an empty-links card) — `device.owned || links.length > 0`
  is the filter; see `projection.ts`'s own doc comment for why (matches
  the acceptance criterion's "absent from the output", not just
  "empty links").
- `SnapshotLink.label`'s exact text format is this ticket's own design
  call (architecture.md §9 gives one illustrative example, not a pinned
  format) — documented as such in `projection.ts`.
- Typecheck residue (informational, per the programmer-agent workflow):
  `npx tsc --noEmit -p packages/host/tsconfig.json` reports errors only
  in `packages/host/src/server.ts` (54 errors, all `EndpointListEntry`/
  `endpointId`/`radio`/`autoRobot`/missing-`seq` fallout from this
  ticket's clean-break rewrite) — expected and out of scope per this
  ticket's own note; ticket 005 fixes it. No other file in
  `packages/host/src` regressed. `packages/ui` was not typechecked here
  (out of this ticket's scope — tickets 007-009 migrate it) but is
  expected to have similar breakage against the removed types, per this
  ticket's own "leave it" instruction.
- Test commands run in the foreground:
  `npx vitest run packages/host/src/projection.test.ts
  packages/host/src/wsMessages.test.ts packages/host/src/store` — 9
  files, 138 tests, all passing.
