---
id: '005'
title: mbrelay pool device modeling and bridging over TCP
status: done
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

- [x] Fake mDNS backend advertising `_mbrelay._tcp` with no matching
      local relay device produces a new `devices(kind='relay')` row
      (synthetic id) and a `links(mbrelay)` row.
- [x] The existing name-match fast path (an mDNS-advertised pool whose
      name matches an already-identified local relay) is unchanged —
      regression guard.
- [x] A bridge through the fake pool runs the full preamble over a fake
      TCP stream with `TCP_NODELAY` set, and uses disconnect+reconnect
      (not a break) as its reset step between candidates.
- [x] Removing the mDNS advertisement ages the device's link out within
      its existing TTL (`watchers/mdnsWatcher.ts`'s aging logic,
      unchanged).
- [x] `grep -rn "mbrelay" packages/host/src/connect` shows the transport
      handled by the shared connector/bridger, not a separate class
      (rearch-11's own acceptance criterion).
- [x] `npx vitest run packages/host/src/watchers packages/host/src/connect`
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

## Implementation notes

- **`watchers/mdnsWatcher.ts`**: `handleMbrelay` now tries
  `uniqueRelayDeviceIdByName(name)` first (unchanged fast path), and
  only on a `null` result (zero existing matches) falls through to a new
  `createRelayDeviceIfAbsent(name)`, which mints a `devices(kind='relay')`
  row keyed by `nameToValue(name)` — the exact synthetic-id convention
  `store/importers/knownRobots.ts` already uses. The ambiguous
  multiple-match case (>1 existing `kind='relay'` device sharing the
  name) is *not* given the fallback — it still returns `null` and the
  link stays unassigned, matching the module's pre-existing "more than
  one match leaves the link unassigned" principle rather than minting a
  third row. The module doc comment's device-linking section was
  extended to describe this asymmetry between `wifi`/`mbserial` (never
  create) and `mbrelay` (create on zero matches).
- **`connect/relayBridger.ts`**: no production changes needed.
  `chooseResetMethod`'s `mbrelay` → `"reconnect"` branch and
  `performReset`'s no-op `"reconnect"` case were already present (added
  in ticket 016-002 alongside the HID/break cases, with their own unit
  test already in place) — a fresh `tcpStream()` per candidate attempt
  already *is* the reconnect, so there was nothing transport-specific
  left to add. This ticket's own work here was verification plus the
  missing integration-level test (see below). `grep -rn "mbrelay"
  packages/host/src/connect` confirms every reference lives in the
  shared `connector.ts`/`relayBridger.ts`/`reconciler.ts` modules, never
  a separate class.
- **Sweeper verification**: `watchers/relaySweeper.ts`'s
  `isEligibleIdleRelayLink` hard-codes `link.transport === "usb"` (line
  ~742) and its own probe path resolves the physical relay via
  `resolveRelayPhysical(store, relayLinkId, "usb")` — an `mbrelay`-
  transport relay is structurally never eligible for a sweep pass. No
  code change needed; confirmed by reading, not by a new test (the
  existing sweeper suite already only ever seeds `usb` relays).
- **Projection**: `buildRelays` (`projection.ts`) keys purely off
  `device.kind === "relay"`, independent of the owning link's transport,
  so a synthetic mbrelay-pool device was already going to show up under
  `relays[]` with no code change. Added a dedicated
  `projection.test.ts` case (`buildSnapshotFromRows` directly, an
  `mbrelay`-transport relay link/device pair under a `session` lease)
  since the checked-in golden fixture only ever covered a `usb`-transport
  relay.
- **Tests added**:
  - `watchers/mdnsWatcher.test.ts`: device-creation fallback (zero
    matches → new device + link), fast-path regression guard (one
    match → unchanged), and an added ambiguous-match guard (two matches
    sharing a name → link stays unassigned, no third device minted).
    Renamed the pre-existing TTL-aging test's mbrelay fixture name from
    `"ggggg"` to the well-formed `"gopoz"` — the new fallback calls
    `nameToValue()` on every mbrelay instance name, which throws on a
    malformed one, and a real mbrelay pool's own mDNS name is always a
    well-formed CODAL name in production, so requiring one in the test
    fixture is correct, not a workaround.
  - `connect/relayBridger.test.ts`: a new `FakeMbrelayPoolSocket`
    (implements `TcpSocketLike`, driven through the *real* `tcpStream()`
    adapter via its own `createSocket` seam — mirroring
    `tcpStream.test.ts`'s own `FakeSocket` fixture) proves the full
    `RelayCommandPlane` preamble runs over it, `TCP_NODELAY` is set on
    every fresh connection, and a stuck-data-plane candidate 1 only
    succeeds on candidate 2 because each candidate gets its own fresh
    socket (disconnect+reconnect) — never a serial break (no
    `sendBreak()` exists on `TcpSocketLike` at all).
  - `projection.test.ts`: new `relays[]` case for an `mbrelay`-transport
    relay device (see above).

**Test commands run** (foreground):
- `npx vitest run packages/host/src/watchers packages/host/src/connect packages/host/src/projection.test.ts packages/host/src/store` → 18 files, 235 tests passed.
- `npm run typecheck` → clean (protocol/host builds + all three `tsc --noEmit` projects, no errors).
