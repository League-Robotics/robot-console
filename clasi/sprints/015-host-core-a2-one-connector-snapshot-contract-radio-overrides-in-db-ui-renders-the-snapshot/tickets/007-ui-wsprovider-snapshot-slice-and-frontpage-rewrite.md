---
id: '007'
title: 'UI: WsProvider snapshot slice and FrontPage rewrite'
status: open
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

- [ ] `WsProvider` exposes only the `snapshot`-derived selectors listed
      above; `endpointsById`/`firmwareStatus`/`rememberedRobots`/
      `discoveredServices`/`wifiCredentials`/`wifiProvisionResultByEndpoint`/
      `flashProgressByEndpoint` no longer exist.
- [ ] A snapshot with an un-owned WiFi device absent and an unassigned
      USB board present renders the unassigned board's card on
      `FrontPage`.
- [ ] `grep -rn "EndpointListEntry\|rememberedRobots\|discoveredServices" packages/ui/src` returns nothing.
- [ ] `grep -rn "groupEndpointsByRobot\|linkScore\|bestClassified" packages/ui/src` returns nothing.
- [ ] FakeSocket fixtures regenerated to the `Snapshot` shape; all
      `FrontPage` tests pass against them.
- [ ] Every `04-ui.md` §1.2 (Front page) row not explicitly called out
      as dropped still has a passing test.

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
