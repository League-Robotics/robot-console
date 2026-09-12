---
id: 008
title: 'UI: DevicePage and RelayPage on the snapshot, one-message relay switch'
status: done
use-cases:
- SUC-008
- SUC-009
depends-on:
- '007'
github-issue: ''
issue: rearch-07-ui-renders-snapshot-drops-client-policy.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: DevicePage and RelayPage on the snapshot, one-message relay switch

## Description

Second of three UI tickets. Covers the two components with client-side
connection policy this rewrite removes by construction:

- `DevicePage.tsx`: route on `linkId` instead of `endpointId`; **delete
  the WiFi auto-open effect** (`:95-108`) that today sends `session-open`
  on mount and on every open→closed transition — the reconciler (ticket
  002) now owns that decision entirely. Keep "Looking for this
  device…"/"This device isn't connected." states, driven by whether the
  `linkId` is present in the snapshot.
- `RelayPage.tsx`: read `relays[].bridging`/`lease` and the child link
  directly from the snapshot instead of scanning `endpoints` for a
  `-via-` id. Connect/Switch sends **one** message,
  `session-open {relayLinkId, name}` — delete the client-sequenced
  `session-close` then `session-open` pair (`:287-289`) now that the
  reconciler (ticket 002, SUC-009) treats a relay child switch as one
  job. Show "idle · sweeping" when `lease === "sweep"` (the lease
  concept lands fully in sprint 016; this sprint's snapshot may report
  `lease: null` until then — render that as today's "idle" state, not
  as an error). `AddressSourceChip` reads `child.radio.source` from the
  snapshot instead of `addressSource`/`failoverTrail` fields being
  reconstructed client-side.
- Delete `DevicePage.test.tsx:264-330` and `RelayPage.test.tsx:351` (the
  "sends X on open" / two-message-switch cases these changes make
  incorrect, not adaptable).

## Acceptance Criteria

- [x] `DevicePage` never sends `session-open` on mount or on any
      transition — only `RelayPage`'s and `FrontPage`'s explicit user
      actions do.
- [x] `grep -rn "session-open" packages/ui/src` shows sends only from
      explicit user actions (Connect/Switch buttons, console "open a
      link").
- [x] Switching a relay's child robot sends exactly one
      `session-open {relayLinkId, name}` message — never a
      `session-close` immediately followed by a `session-open`.
- [x] `RelayPage` renders the connected child, its `AddressSourceChip`,
      and the "idle · sweeping" state purely from `relays[]`/the
      device's `links[]` in the snapshot — no `-via-` id parsing
      remains.
- [x] `DevicePage.test.tsx:264-330` and `RelayPage.test.tsx:351` (by
      their sprint-014-era line numbers, or the equivalent "sends X on
      open"/two-message-switch cases) are deleted, not adapted.
- [x] Every `04-ui.md` §1.3/§1.4 (Device page shell, Relay page) row not
      explicitly called out as dropped still has a passing test.

## Implementation Plan

**Approach**: `DevicePage` first (small, mostly deletion), then
`RelayPage` (larger, restructures around the snapshot's `relays[]`).

**Files to modify**:
- `packages/ui/src/pages/DevicePage.tsx`
- `packages/ui/src/pages/RelayPage.tsx`
- `packages/ui/src/components/AddressSourceChip.tsx` (input shape only,
  if it changes)

**Files to delete/trim**:
- `DevicePage.test.tsx`'s WiFi-auto-open test cases
- `RelayPage.test.tsx`'s two-message-switch test case

**Testing plan**:
- FakeSocket: `DevicePage.test.tsx` — no auto-send on mount/transition;
  `RelayPage.test.tsx` — one-message switch, idle/sweeping rendering,
  `AddressSourceChip` from snapshot fields.
- Run: `npx vitest run packages/ui/src/pages/DevicePage.test.tsx packages/ui/src/pages/RelayPage.test.tsx`.

**Documentation updates**: none.

## Implementation notes

Delivered the ticket's own scope plus the team-lead's four additions,
in two commits (host, then UI):

- **Host one-message relay switch** (`packages/host/src/server.ts`):
  the `{relayLinkId, name}` `session-open` handler now resolves the
  named robot's radio address via `radioOverride.ts`'s
  `resolveDeviceRadio` (looked up by an existing device's own `name`,
  never by recomputing an id from the name -- `nameToValue` is the
  derived-address helper, not a name -> device-id inverse, and many
  device ids can decode to the same name), ensures a deterministic
  `links` row (`radio-<name>-via-<relayLinkId>`), and forwards that
  `linkId` to `runtime.reconciler.requestOpen` so `planUserOpen`
  (ticket 002) performs the close-old + open-new job as one unit.
  `registry` (a live mbrelay location) is not wired in yet -- no
  watcher discovers one anywhere in this runtime -- so resolution
  always falls through `override -> derived`; a future ticket that
  wires mdns-discovered registry location in gets `registry` for free
  through the same resolver. Added `server.test.ts` cases (name-derived
  address, device-override address, idempotent reuse of the same link
  row on a repeat bridge) against a real temp-file `Store` and a fake
  reconciler.
- **`DevicePage`/`RelayPage`/`UnknownDevicePage`** rewritten on
  `linkId`/`useLink`/`useDeviceForLink`/`useDevices`/`useRelays`. The
  route param itself is renamed `/d/:endpointId` -> `/d/:linkId`
  (`router.tsx`, `AppHeader.tsx`). Dispatch collapsed to: no owning
  device -> `UnknownDevicePage`; `device.kind === "relay"` ->
  `RelayPage`; `"robot"` -> `RobotPage` (calibration is just a `"robot"`
  device with a `calibration-` program prefix now, not a separate
  dispatch arm). The WiFi auto-open effect is deleted outright, not
  adapted. `RelayPage` finds its bridged child by scanning `devices[]`
  for a link whose `via.relayLinkId` matches the relay's own
  connectivity link (mirrors `FrontPage.tsx`'s own `findRelayChild`);
  Connect/Switch both send exactly `{session-open, relayLinkId, name}`;
  `lease: null` renders "idle", `lease: "sweep"` renders "idle ·
  sweeping" (both only when nothing is bridging in-flight).
- **`AddressSourceChip`** rewritten to a single required `radio:
  {channel, group, source}` prop (mirrors `SnapshotDevice.radio`
  exactly) -- the old five-outcome `AddressSource`/`registryWasConsidered`/
  `failoverTrail` model has no host-reported equivalent left (the new
  `RadioSourceWire` is only three values, always already resolved), so
  the chip is now always neutral rather than fabricating a warning the
  data doesn't support. `ConfigurationPage` now mounts this shared chip
  in place of its own inline `radioSourceLabel` paragraph (that
  function is deleted).
- **`FlashDialog`/`FlashControls`/`WifiCredentialsDialog`** migrated to
  `SnapshotLink`/`linkId` (flash progress and `flash-start` key on
  `link.id`; Wi-Fi provisioning keys on `linkId`). `AppHeader`'s Flash
  entry is restored for *any* resolvable link (owned or not,
  `forceShow`, matching the pre-ticket-007 "any endpoint" behavior) and
  Set Wi-Fi is restored gated the same way Set Radio already was (a
  real, non-relay device). The front-page Flash trigger is restored on
  `UnassignedCard` -- the direct successor of the old "role === null"
  front-page state now that an unidentified board has no device row at
  all.
- **Deviation beyond the ticket's own file list, both necessary for
  `RelayPage`'s own tests to render without crashing (RelayPage and
  UnknownDevicePage both mount it)**: `DeviceConsole.tsx` migrated to a
  `{link, name}` prop (was `{device: EndpointListEntry}`), and
  `SequencingIndicator.tsx` (mounted inside `DeviceConsole`) migrated to
  take the link's own `session` field directly as a prop instead of a
  retired `useSequencing(endpointId)` hook that no longer exists on
  `WsProvider`. Both are otherwise `RobotPage`-panel-adjacent (ticket
  009's usual territory) but were unavoidable here.
- **`RobotPage.tsx` is intentionally not touched** (ticket 009's own
  migration). `DevicePage.tsx`'s `"robot"` dispatch arm and
  `RelayPage.tsx`'s connected-child mount both still call `<RobotPage
  endpoint={someSnapshotDevice} />` against its old, unmigrated
  `{ endpoint: EndpointListEntry }` prop type -- in practice this
  produces **no** tsc error at either call site (the retired
  `EndpointListEntry` import inside `RobotPage.tsx` itself fails to
  resolve, which degrades that prop's type to `any` there, so nothing
  downstream sees a mismatch) but `RobotPage.tsx` still fails to render
  correctly for a real robot at runtime until ticket 009 lands (several
  of its own child panels call hooks `WsProvider` no longer exports).
  `DevicePage.test.tsx`/`RelayPage.test.tsx` mock `./RobotPage` with a
  thin stub so this ticket's own dispatch/rendering logic is provable
  without depending on that unmigrated subtree.
- **UI tsc**: 79 -> 34 errors. Zero remain in any file this ticket
  touches; all 34 are in `RobotPage.tsx` (2, both pre-existing/
  ticket-009-shaped: the `ConfigurationPage` call site from ticket 007,
  now joined by the `DeviceConsole` call site) plus its panels
  (`FunctionsPanel`, `RotationCalibrationWizard`,
  `DistanceCalibrationWizard`, `DriveControls`, `DriveTab`,
  `CommandStrip`, `CalibrationPage`, `StatusPanel`) and those files' own
  tests. Host tsc stayed clean (0 errors) throughout.
- Not carried forward, confirmed dropped by earlier tickets (not a
  regression introduced here): the per-connect channel/group override
  inputs and the no-pick `autoRobot` default-failover request (both
  retired from the wire contract by tickets 006/004-005); the
  `AddressSourceChip` failover-trail/registry-considered nuance (see
  above).
