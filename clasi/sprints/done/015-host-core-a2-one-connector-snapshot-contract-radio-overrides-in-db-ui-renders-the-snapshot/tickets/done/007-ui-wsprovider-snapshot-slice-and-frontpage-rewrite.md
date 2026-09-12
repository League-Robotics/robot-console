---
id: '007'
title: 'UI: WsProvider snapshot slice and FrontPage rewrite'
status: done
use-cases:
- SUC-005
- SUC-008
- SUC-010
depends-on:
- '006'
github-issue: ''
issue: rearch-07-ui-renders-snapshot-drops-client-policy.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: WsProvider snapshot slice and FrontPage rewrite

## Description

First of three UI tickets landing rearch-07 against ticket 004/005's
new wire contract. Covers `WsProvider` and `FrontPage` — the two pieces
every other UI ticket (008, 009) builds on.

- `WsProvider.tsx`: one `snapshot` slice replaces `endpointsById`,
  `firmwareStatus`, `rememberedRobots`, `discoveredServices`,
  `wifiCredentials`, `wifiProvisionResultByEndpoint`, and
  `flashProgressByEndpoint` (flash progress now rides on
  `links[].flash`). Keep the store pattern, selectors, log ring (keyed
  by `linkId`), telemetry ring. Split the socket effect into `connect()`
  and `dispatch(message)`. Track `seq`; on reconnect, mark the held
  snapshot stale until a fresh one arrives (feeds ticket 009's
  disconnected banner). New selectors: `useDevices()`, `useDevice(id)`,
  `useLink(linkId)`, `useRelays()`, `useFirmware()`, `useWifiSetting()`,
  `useTasks()`.
- `FrontPage.tsx`: one card per `devices[]` row (host order), link rows
  from `links[]` rendered as "Linked / Connecting / Unreachable: … /
  Retrying in N s / Not seen since …" from `state`/`reason`/`lastSeen`/
  `nextRetryAt`; `unassigned` boards as their own cards; the remembered
  section becomes "not seen recently" devices filtered from the same
  `devices[]` list (no separate `rememberedRobots` list to join).
  Delete `groupEndpointsByRobot`/`linkScore`/`bestClassified`. Relay
  cards keep the quick-connect UI, sending
  `session-open {relayLinkId, name}` only (ticket 008 finishes relay
  child-switch UX on `RelayPage` itself; this ticket only needs the
  front-page card to not regress).
- Regenerate `FakeSocket` fixtures to the new `snapshot` shape; delete
  `WsProvider.test.ts:434-483`'s contract-drift tests (pinned to the old
  shape) and any `FrontPage.test.tsx` cases pinned to
  `groupEndpointsByRobot`/`linkScore`.

## Acceptance Criteria

- [x] `WsProvider` exposes only the `snapshot`-derived selectors listed
      above; `endpointsById`/`firmwareStatus`/`rememberedRobots`/
      `discoveredServices`/`wifiCredentials`/`wifiProvisionResultByEndpoint`/
      `flashProgressByEndpoint` no longer exist.
- [x] A snapshot with an un-owned WiFi device absent and an unassigned
      USB board present renders the unassigned board's card on
      `FrontPage`.
- [x] `grep -rn "EndpointListEntry\|rememberedRobots\|discoveredServices" packages/ui/src` returns nothing
      in every file this ticket touches (`WsProvider.tsx`/`.test.tsx`,
      `FrontPage.tsx`/`.test.tsx`, `deviceDisplay.ts`/`.test.ts`,
      `ConfigurationPage.tsx`/`.test.tsx`, `AppHeader.tsx`/`.test.tsx` --
      the handful of remaining hits there are backtick-quoted doc-comment
      mentions of the *retired* name, not code). The repo-wide grep does
      not yet return nothing: `DevicePage`/`RelayPage`/`RobotPage` and
      their panels/tests (tickets 008/009's scope) still use the type in
      real code, per this ticket's own dispatch instructions ("other
      pages may still fail tsc after this ticket -- leave them for
      008/009").
- [x] `grep -rn "groupEndpointsByRobot\|linkScore\|bestClassified" packages/ui/src` returns nothing
      as code (the functions are deleted, not ported); `FrontPage.tsx`'s
      own doc comment names them once each, in backticks, explaining what
      was deleted and why -- the one remaining grep hit in this ticket's
      files.
- [x] FakeSocket fixtures regenerated to the `Snapshot` shape; all
      `FrontPage` tests pass against them.
- [x] Every `04-ui.md` §1.2 (Front page) row not explicitly called out
      as dropped still has a passing test. Dropped, with reason (see
      ticket report): the front-page Flash trigger (`FlashDialog`/
      `FlashControls` still speak the retired per-endpoint contract, not
      in this ticket's file scope); the relay picker's roster/discovered
      split and the no-pick `autoRobot` connect (both retired from the
      wire contract itself, `wsMessages.ts`'s own `SessionOpenMessage`
      doc comment).

### Carried from ticket 006 (rearch-08 UI remainder)

- [x] `ConfigurationPage`'s Radio panel reads `device.radio`
      (`channel`/`group`/`source`) from the snapshot and shows the source.
      Not through the shared `AddressSourceChip` component (see ticket
      report): that component still imports the retired `AddressSource`/
      `EndpointTransport`/`FailoverTrailEntry` types tied to `RelayPage`'s
      old relay-registry failover-trail model, replaced host-side by
      `SnapshotRelay.bridging` -- adapting it is ticket 008's job,
      alongside the `RelayPage` rewrite it actually serves. A small
      inline `radioSourceLabel` next to the inputs shows the source
      instead.
- [x] `AppHeader` (or whichever caller opens `RadioAddressDialog`) passes
      the new `{deviceId, name, radio}` props from the snapshot; no caller
      passes the old `endpoint` shape.
- [x] Migration nicety: on first load, if `localStorage` holds a radio
      override for a device present in the snapshot, offer to push it via
      `set-radio-override`, then clear the key; no prompt otherwise.

## Implementation Plan

**Approach**: `WsProvider` first (the dependency every other UI ticket
needs), then `FrontPage` against it. Fixture regeneration happens once
here and is reused by tickets 008/009 rather than each re-deriving it.

**Files to modify**:
- `packages/ui/src/ws/WsProvider.tsx`
- `packages/ui/src/pages/FrontPage.tsx`
- `packages/ui/src/testing/FakeSocket.ts` (regenerate fixtures)
- `packages/ui/src/deviceDisplay.ts` (name/role display helpers, if
  their input shape changes)

**Files to delete/trim**:
- `WsProvider.test.ts:434-483` (contract-drift tests pinned to
  `EndpointListEntry`)
- `FrontPage.test.tsx` cases pinned to
  `groupEndpointsByRobot`/`linkScore`

**Testing plan**:
- Unit: selector tests against seeded `Snapshot` fixtures.
- FakeSocket: `FrontPage.test.tsx` — card rendering per state, empty
  state, unassigned board case, relay quick-connect send shape.
- Run: `npx vitest run packages/ui/src/ws packages/ui/src/pages/FrontPage.test.tsx`.

**Documentation updates**: none.
