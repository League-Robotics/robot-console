---
id: 008
title: 'UI: DevicePage and RelayPage on the snapshot, one-message relay switch'
status: in-progress
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

- [ ] `DevicePage` never sends `session-open` on mount or on any
      transition — only `RelayPage`'s and `FrontPage`'s explicit user
      actions do.
- [ ] `grep -rn "session-open" packages/ui/src` shows sends only from
      explicit user actions (Connect/Switch buttons, console "open a
      link").
- [ ] Switching a relay's child robot sends exactly one
      `session-open {relayLinkId, name}` message — never a
      `session-close` immediately followed by a `session-open`.
- [ ] `RelayPage` renders the connected child, its `AddressSourceChip`,
      and the "idle · sweeping" state purely from `relays[]`/the
      device's `links[]` in the snapshot — no `-via-` id parsing
      remains.
- [ ] `DevicePage.test.tsx:264-330` and `RelayPage.test.tsx:351` (by
      their sprint-014-era line numbers, or the equivalent "sends X on
      open"/two-message-switch cases) are deleted, not adapted.
- [ ] Every `04-ui.md` §1.3/§1.4 (Device page shell, Relay page) row not
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
