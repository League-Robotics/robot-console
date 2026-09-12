---
id: '002'
title: 'Relay failover: relayBridger with per-candidate reset, candidate ordering,
  registry-free default failover'
status: done
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: rearch-09-relay-lease-idle-state-reset-between-candidates.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay failover: relayBridger with per-candidate reset, candidate ordering, registry-free default failover

## Description

Fixes the Linux failover bug at its root and completes rearch-09. Today
`connector.ts`'s `attempt()` already bridges a single, already-named
radio/mbrelay child link (address resolution, `relay_leases` acquisition
with owner `session:<childLinkId>`, the full `!ECHO OFF`→`!GO` preamble)
— but there is no reset step before that preamble, and no candidate list:
only one already-named child. On Linux, a relay left in the data plane by
a prior failed candidate never recovers (no reset), so every candidate
after the first sends its sync into a relay that cannot hear it; this
only ever appeared to work on macOS because opening the port happens to
reset the board via DTR.

Build `packages/host/src/connect/relayBridger.ts` (new file, per
rearch-09's own naming) as a sibling to `connector.ts`, not a rewrite of
it — see sprint.md's Design Rationale ("relayBridger.ts is a new sibling
module to connector.ts") for why. It reuses `connector.ts`'s existing
address-parsing/exclusivity helpers where practical (a ticket-level
refactor, not a copy) and composes the same `RelayCommandPlane.ts`
preamble, but adds:

- A reset step before every candidate's preamble, chosen by the relay's
  own physical capability: DAPLink-over-HID when the relay's `usb` link
  carries a `hidPath` (from `watchers/usbWatcher.ts`'s `usbLinkAddress`,
  already recorded), else a serial break (`link/adapters/serialStream.ts`
  needs a new `break()`-style capability — it currently exposes only
  `open`/`write`/`on`/`close`), else a port reopen (macOS fallback, or a
  disconnect+reconnect for a TCP mbrelay relay — see ticket 005).
- A real candidate list for the no-name-picked "default failover" path:
  robots with a recent radio `sighting` first, then remembered robots by
  `last_seen`. Address resolution per candidate uses the existing
  `override → last radio sighting → derived` order — no registry GET
  during default failover (rearch-09's own explicit acceptance
  criterion).
- Opening the relay's raw transport directly (`serialStream`/`tcpStream`,
  the same adapters `connector.ts` uses) rather than through
  `connector.connectAndIdentify`, per sprint.md's Design Rationale
  ("relayBridger/relaySweeper open the relay's raw transport directly").

Wire this into the reconciler: `planUserOpen`'s existing
`switchRelayChild` job (already produced today) should call
`relayBridger.bridge()` instead of the plain `connectAndIdentify` path
for a radio/mbrelay child link. A named `session-open {relayLinkId,
name}` still bridges to exactly that one robot (no candidate list); the
candidate list only applies when no name is given.

## Acceptance Criteria

- [x] Fake relay with plane state: candidate 1 answers `!GO` but never
      replies afterward (simulating a stuck data plane); candidate 2
      still succeeds, and the fake observed a reset between them.
- [x] The identical fixture *without* the reset step between candidates
      fails — this is the specific regression test guarding the Linux
      bug; it must fail against the pre-fix code path and pass against
      this ticket's fix.
- [x] No registry GET is issued during default failover; address
      resolution uses override → last radio sighting → derived only.
- [x] A serial-only relay (`hidPath` absent) uses the break path in
      tests; one with a `hidPath` uses HID reset.
- [x] A named `session-open {relayLinkId, name}` bridge (no candidate
      list) still works exactly as before this ticket — regression
      guard against `connector.test.ts`'s existing radio/mbrelay cases.
- [x] `relay_leases.owner` transitions `session:<childLinkId>` → released
      on both success and failure paths (lease never leaked).
- [x] `npx vitest run packages/host/src/connect packages/host/src/link`
      passes.

## Implementation Plan

**Approach**: Extract the reusable parts of `connector.ts`'s existing
radio/mbrelay handling (address parsing, exclusivity resolution,
`resolveRelayPhysical`) into helpers both `connector.ts` and
`relayBridger.ts` can call, per sprint.md's Design Rationale. Add the
reset-method-selection function (HID / break / reconnect) and the
candidate-ordering function (sighted-first, then `last_seen`) as pure,
separately testable functions before wiring the full `bridge()` loop
around them — mirrors sprint 015's own connector-testing precedent (a
shared fake `ByteStream` harness).

**Files to create/modify**:
- `packages/host/src/connect/relayBridger.ts` (new).
- `packages/host/src/link/adapters/serialStream.ts` (add a break/reset
  capability — check `serialport`'s own `set({brk: true})` API first).
- `packages/host/src/connect/connector.ts` (extract shared helpers only;
  its own single-candidate radio/mbrelay path may be able to delegate to
  `relayBridger.ts` for the named-connect case too — a ticket-level call,
  not prescribed further here).
- `packages/host/src/connect/reconciler.ts` (`switchRelayChild` job
  dispatch calls `relayBridger.bridge()` for radio/mbrelay children).

**Testing plan**:
- `link/adapters/serialStream.test.ts`: the new break capability against
  a fake `SerialPortLike`.
- `connect/relayBridger.test.ts` (new): the fake-relay-with-plane-state
  reset regression test (the ticket's headline acceptance criterion),
  candidate ordering, registry-free failover, lease acquire/release.
- Regression: `connect/connector.test.ts`'s existing radio/mbrelay cases
  still pass unmodified (or migrated, not deleted, if the named-connect
  path moves into `relayBridger.ts`).
- Scoped run: `npx vitest run packages/host/src/connect
  packages/host/src/link`.

**Documentation updates**: none beyond this ticket's own completion notes
on which reset method was verified against which fixture.

## Implementation notes

**New module**: `packages/host/src/connect/relayBridger.ts`
(`createRelayBridger(store, deps, opts)` → `RelayBridger.bridge(request,
signal)`). A `BridgeRequest` is always `{relayLinkId, candidates[]}` —
one shared reset→preamble→identify loop serves both shapes:
- **Named** (today's only real production call site):
  `toBridgeRequest(link)` wraps one already-resolved radio/mbrelay child
  `LinkRow` into a single-candidate request. `connect/reconciler.ts`'s
  executor now calls `bridger.bridge()` instead of
  `connector.connectAndIdentify()` for a `radio`/`mbrelay`-transport
  `connect`/`switchRelayChild` job, via a new optional
  `ReconcilerDeps.bridger` (falls back to `connector` when omitted, so
  every pre-existing reconciler/connector test that never supplies a
  bridger is unmodified regression coverage of the untouched
  `connector.ts` path). `runtime.ts` always constructs and wires a real
  one in production.
- **Default failover** (no name picked): `buildDefaultFailoverCandidates`
  (sighted-first via the new `Store.radioSightings()` typed read, then
  `last_seen`) + `resolveDefaultFailoverAddress` (override → derived,
  never the registry — this function's own signature has no `registry`
  parameter at all, so it is structurally incapable of a registry GET,
  not merely configured not to make one). Not yet wired to a live
  wire-protocol entry point — `wsMessages.ts`'s `SessionOpenMessage` has
  no "relayLinkId with no name" shape yet — exported and fully tested for
  whichever future ticket adds that UI/wire path.

**Reset method verified per fixture** (`relayBridger.test.ts`):
`chooseResetMethod(hidPath, relayTransport)` is pure (`hid` when a `usb`
relay's own link carries a `hidPath`; `break` for a `usb` relay with
none; `reconnect` for an `mbrelay` relay, verified for both `hidPath`
states — reconnect never depends on it). Verified against the shared
`RelayPlaneByteStream`/`RelayPlaneState` fixture (a fake relay carrying
"am I in the data plane" state across the fresh per-candidate stream
instances this module opens, mirroring a real relay board's own firmware
state persisting across an open/close cycle):
- **HID**: relay seeded with a `hidPath` → the injected `hidReset(hidPath,
  signal)` fires and the fake's `sendBreak()` is never called.
- **Break**: relay with no `hidPath` → `SerialResettableStream.sendBreak()`
  (new capability on `link/adapters/serialStream.ts`, real implementation
  asserts `serialport`'s `set({brk:true})` then clears it after
  `durationMs` — `serialStream.test.ts` covers assert/clear order,
  default duration, and both failure paths against a fake
  `SerialPortLike`) fires and `hidReset` is never called.
- **Reconnect** (`mbrelay`): a no-op by design — a fresh TCP stream opened
  per candidate attempt already is the reconnect; `chooseResetMethod`'s
  own unit test covers the selection, full TCP bridging is ticket 005's
  own scope.

**Headline regression test**: two candidates against
`RelayPlaneByteStream`; candidate 1 confirms `!GO` (relay enters the fake's
shared data-plane state) but its own robot never answers `HELLO`
(identify times out); candidate 2 succeeds only because the reset
(`RelayPlaneState.reset()`) ran first and cleared the data-plane flag,
letting `sync()`'s `?` probe get answered again. The *identical* fixture
with `resetBetweenCandidates: false` (a real, documented option — not a
private test hook) fails with "no candidate identified", proving the
reset is what the Linux bug's fix actually depends on, not some other
difference between the two runs.

**`connector.ts`**: behavior-unchanged; several previously-private
helpers (`parseLinkAddress`, `resolveRelayPhysical`, `resolveExclusivity`/
`acquireExclusivity`/`releaseExclusivity`, `buildRelayPreamble` — now
also accepting an optional `syncOptions` pass-through, unused by
`connector.ts`'s own call site — `identifyWithAbort`, `recordFailure`,
`toError`, `abortError`, `usbSerialFromLinkId`, plus `NO_OP_HARVESTER` and
a few constants) are now `export`ed for `relayBridger.ts` to reuse
verbatim, per sprint.md's own Design Rationale ("a new sibling module to
connector.ts, not a rewrite"). `connector.test.ts` passes unmodified —
its own single-candidate, no-reset radio/mbrelay path is untouched and
still the thing that path is regression-tested against.

**Lease lifecycle**: one `relay_leases` acquisition
(`session:<candidates[0].childLinkId>`) covers the whole candidate loop,
released in `finally` on both success and total exhaustion — verified by
inspecting `store.reconcilerRows().relayLeases` after both outcomes, plus
a conflict case (a `sweep`-held lease) that rejects immediately without
ever attempting a candidate or disturbing the other owner's lease.

**Not done in this ticket** (explicitly out of scope per the plan): no
wire-protocol/UI entry point for default failover (`session-open` with no
name); no mbrelay TCP bridging integration test beyond
`chooseResetMethod`'s own selection (ticket 005); no sightings *write*
path (the sweeper, ticket 003, is what will populate
`Store.radioSightings()` with real data — this ticket only adds the typed
read and consumes it).
