---
id: '005'
title: mbrelay pool device modeling and bridging over TCP
status: in-progress
use-cases:
- SUC-005
depends-on:
- '002'
github-issue: ''
issue: rearch-11-mbrelay-mbserial-real-transports.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbrelay pool device modeling and bridging over TCP

## Description

`watchers/mdnsWatcher.ts`'s `handleMbrelay` today only attaches a
`links(mbrelay)` row to an *already existing* `devices(kind='relay')` row
with a matching name (`uniqueRelayDeviceIdByName`) — it never creates
one. This is confirmed by sprint 015 ticket 011's own bench evidence:
`torture` (a live mbrelay pool) never appeared in any snapshot all
session because this host had never identified `torture` over USB.

Add a device-creation fallback to `handleMbrelay`: when no existing
`kind='relay'` device matches the mDNS instance name, create one with a
synthetic, name-derived id — the same convention
`store/importers/knownRobots.ts` already uses for a device with no known
chip id (see sprint.md's Design Rationale for why this device has no
future "merge" path, unlike a USB placeholder). The existing name-match
fast path stays for an already-known local relay.

Bridging through the resulting device needs no new transport-specific
code: `connector.ts`'s `resolveRelayPhysical`/`buildStreamPlan` are
already transport-symmetric between a local `usb` relay and a remote
`mbrelay` pool, and ticket 002's `relayBridger.ts` already generalizes
over both. This ticket's own transport-specific addition is the reset
step for a TCP relay: disconnect+reconnect (a break cannot be sent over
TCP, specification.md §6) — extend ticket 002's reset-method selection
with this third case.

## Acceptance Criteria

- [ ] Fake mDNS backend advertising `_mbrelay._tcp` with no matching
      local relay device produces a new `devices(kind='relay')` row
      (synthetic id) and a `links(mbrelay)` row.
- [ ] The existing name-match fast path (an mDNS-advertised pool whose
      name matches an already-identified local relay) is unchanged —
      regression guard.
- [ ] A bridge through the fake pool runs the full preamble over a fake
      TCP stream with `TCP_NODELAY` set, and uses disconnect+reconnect
      (not a break) as its reset step between candidates.
- [ ] Removing the mDNS advertisement ages the device's link out within
      its existing TTL (`watchers/mdnsWatcher.ts`'s aging logic,
      unchanged).
- [ ] `grep -rn "mbrelay" packages/host/src/connect` shows the transport
      handled by the shared connector/bridger, not a separate class
      (rearch-11's own acceptance criterion).
- [ ] `npx vitest run packages/host/src/watchers packages/host/src/connect`
      passes.

## Implementation Plan

**Approach**: Add the device-creation fallback to `handleMbrelay` as a
small, additive change (the existing name-match call becomes the first
of two checks, not a replacement). Add the TCP reset-method case to
ticket 002's reset-selection function — a relay link's `transport` field
already distinguishes `usb` from `mbrelay`, so the selection function
only needs one more branch.

**Files to modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` (`handleMbrelay`'s
  device-creation fallback).
- `packages/host/src/connect/relayBridger.ts` (TCP reset-method case).
- `packages/host/src/store/index.ts` only if a synthetic-id helper
  doesn't already exist in a reusable form (check
  `store/importers/knownRobots.ts` first — reuse its id-derivation
  function rather than duplicating it).

**Testing plan**:
- `watchers/mdnsWatcher.test.ts`: the device-creation fallback and the
  regression guard for the existing name-match path.
- `connect/relayBridger.test.ts`: the TCP reset-step case (fake
  `tcpStream`, `TCP_NODELAY` assertion, disconnect+reconnect sequencing).
- Scoped run: `npx vitest run packages/host/src/watchers
  packages/host/src/connect`.

**Documentation updates**: none beyond this ticket's own completion notes.
