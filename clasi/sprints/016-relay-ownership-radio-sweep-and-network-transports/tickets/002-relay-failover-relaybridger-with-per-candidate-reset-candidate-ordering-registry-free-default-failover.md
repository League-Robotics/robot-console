---
id: '002'
title: 'Relay failover: relayBridger with per-candidate reset, candidate ordering,
  registry-free default failover'
status: open
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

- [ ] Fake relay with plane state: candidate 1 answers `!GO` but never
      replies afterward (simulating a stuck data plane); candidate 2
      still succeeds, and the fake observed a reset between them.
- [ ] The identical fixture *without* the reset step between candidates
      fails — this is the specific regression test guarding the Linux
      bug; it must fail against the pre-fix code path and pass against
      this ticket's fix.
- [ ] No registry GET is issued during default failover; address
      resolution uses override → last radio sighting → derived only.
- [ ] A serial-only relay (`hidPath` absent) uses the break path in
      tests; one with a `hidPath` uses HID reset.
- [ ] A named `session-open {relayLinkId, name}` bridge (no candidate
      list) still works exactly as before this ticket — regression
      guard against `connector.test.ts`'s existing radio/mbrelay cases.
- [ ] `relay_leases.owner` transitions `session:<childLinkId>` → released
      on both success and failure paths (lease never leaked).
- [ ] `npx vitest run packages/host/src/connect packages/host/src/link`
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
