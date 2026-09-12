---
id: '004'
title: Snapshot/Notice wire contract and buildSnapshot projection
status: open
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

- [ ] Golden test: seeded rows → `buildSnapshot()` equals a checked-in
      JSON fixture covering an owned robot with USB+WiFi+radio links, an
      un-owned WiFi robot (absent from the output), an unnamed USB board
      (`unassigned`), and a relay under a sweep lease.
- [ ] `capabilities` on each link row correctly reflects
      open/close/flash/provisionWifi eligibility for that link's state
      and transport.
- [ ] `grep -rn "EndpointListEntry\|rememberedRobots\|discoveredServices" packages/host/src` returns nothing (server.ts/cli.ts are expected to still fail to compile until ticket 005 — see that ticket's note).
- [ ] `session-open`'s wire type accepts `{linkId}` or `{relayLinkId, name}` and no longer accepts a `radio` field.
- [ ] `forget-known-robot` no longer exists in `wsMessages.ts`; `forget-device {deviceId}` does.

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
