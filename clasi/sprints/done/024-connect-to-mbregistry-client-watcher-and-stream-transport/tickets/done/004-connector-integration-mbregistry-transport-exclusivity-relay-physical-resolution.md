---
id: '004'
title: 'Connector integration: mbregistry transport, exclusivity, relay physical resolution'
status: done
use-cases:
- SUC-004
depends-on:
- '001'
- '003'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Connector integration: mbregistry transport, exclusivity, relay physical resolution

## Description

Wire `mbregistryStream` (ticket 003) into `connect/connector.ts`
(sprint.md Architecture Step 3/Step 5):

1. `parseLinkAddress`: add an `"mbregistry"` case parsing
   `{endpoint, uid}` into a typed `MbregistryAddress`.
2. `resolveExclusivity`: add `"mbregistry"` → `{ kind: "none" }` (mirrors
   `wifi`/`mbserial` today) — mbregistry's own `lock` is the sole
   exclusivity for this transport; `board_owner`/`relay_leases` are
   never touched for it.
3. `buildStreamPlan`: add `"mbregistry"` → `createMbregistryStream(address)`
   (a new injectable `ConnectorDeps.createMbregistryStream`, defaulting
   to the real adapter from ticket 003, mirroring
   `createSerialStream`/`createTcpStream`'s own injection convention).
4. `resolveRelayPhysical(store, relayLinkId, expectedTransport)`: add a
   third `expectedTransport: "mbregistry"` branch (sprint.md's explicit
   call-out — a `radio`/`mbrelay`-address link's `relayLinkId` can now
   point at an `mbregistry`-transport row instead of `usb`/`mbrelay`),
   resolving to `{transport: "mbregistry", address: {endpoint, uid}}`.
   Update `buildStreamPlan`'s `radio`/`mbrelay` case to construct an
   `mbregistryStream` when the resolved physical transport is
   `"mbregistry"`, alongside the existing serial/tcp branches.
5. `usbSerialFromLinkId`/`USB_LINK_ID_PREFIX` are untouched — an
   `mbregistry`-transport link uses a different id convention (owned by
   `mbregistryWatcher`, ticket 002); do not force it through the
   `usb-<serial>` parsing path.

No change to `parseLinkAddress`/`resolveExclusivity`'s existing
`usb`/`wifi`/`mbserial`/`radio`/`mbrelay` branches — purely additive.

## Acceptance Criteria

- [x] A `links` row with `transport: "mbregistry"` connects through
      `connectAndIdentify` exactly like a `usb`/`wifi` row does today
      (banner identify, `deviceId`/`kind`/`owned` bookkeeping, placeholder
      merge — all unchanged code paths downstream of `buildStreamPlan`).
- [x] `resolveExclusivity` for `mbregistry` never calls
      `acquireBoardOwner`/`acquireRelayLease` — verified by a test
      asserting no `board_owner`/`relay_leases` row is written.
- [x] A `radio`/`mbrelay`-address link whose `relayLinkId` resolves to an
      `mbregistry`-transport row opens its relay hop through
      `mbregistryStream`, not a parse error.
- [x] Existing `connector.test.ts` cases for `usb`/`wifi`/`mbserial`/
      `radio`/`mbrelay` (with a `usb`/`mbrelay` relay physical) are
      unmodified and still pass.
- [x] A malformed `mbregistry` address (missing `endpoint`/`uid`) fails
      with the same descriptive-`Error`-then-`recordFailure` pattern
      every other transport uses.

## Implementation Notes (deviations from plan)

- **`store/index.ts`'s `Transport` union already carried `"mbregistry"`**
  (added ahead of schedule by ticket 002, `mbregistryWatcher`) — no
  change needed there. `resolveExclusivity`'s `"mbregistry" -> {kind:
  "none"}` case was likewise already present in `connector.ts` (a
  ticket-001-era placeholder matching sprint.md's already-decided final
  value verbatim) — left unmodified, comment updated to point at where
  the real lock acquisition now happens (`mbregistryStream`'s own
  `open()`).
- **`ConnectorDeps` gained two fields beyond the ticket's own literal
  text** (`createMbregistryStream` plus `mbregistryClient`/
  `mbregistryLabel`), not just `createMbregistryStream` alone. Unlike
  `createSerialStream(path)`/`createTcpStream(host, port)`, the real
  `mbregistryStream()` adapter (ticket 003) needs an already-connected
  `MbregistryClient` instance, which `connector.ts` has no other way to
  receive — `createMbregistryStream`'s own default therefore closes over
  `deps.mbregistryClient` (throwing a clear configuration error if
  neither it nor an overriding `createMbregistryStream` is supplied).
  Wiring a real `mbregistryClient` in from `runtime.ts`'s composition
  root is not part of this ticket's own file list and is left for a
  later ticket (024-006 constructs the client; nothing in its own
  Description mentions passing it through `connectorDeps`, so this
  remains an open wiring gap beyond 024-006 too, flagged here rather
  than silently assumed done elsewhere).
- **`resolveRelayPhysical`'s new `"mbregistry"` branch is unconditional,
  not keyed by `expectedTransport`**: the function now accepts a relay
  row of transport `"mbregistry"` regardless of whether the caller's
  `expectedTransport` was `"usb"` or `"mbrelay"` (sprint.md's own
  wording: "a `radio`/`mbrelay`-address link's `relayLinkId` can now
  point at an `mbregistry`-transport row instead of `usb`/`mbrelay`" —
  either address kind, not a third `expectedTransport` value threaded
  through every call site).
- **`connect/relayBridger.ts` required one small, unavoidable edit**
  outside this ticket's own "Files to modify" list: `resolveRelayPhysical`
  is `export`ed and already reused by `relayBridger.ts` (ticket 016-002),
  so widening `RelayPhysical.transport` to include `"mbregistry"` is a
  breaking type change for that module's own `attemptCandidate()`, which
  narrows `physical.transport` to `"usb" | "mbrelay"` for `chooseResetMethod`/
  stream construction. Added an explicit guard there that throws
  `"...not yet supported here (sprint 024 ticket 007)"` when an
  `mbregistry`-transport relay row is resolved — declining the case
  cleanly instead of mis-casting `physical.address`, until ticket 007
  (`relayBridger`'s own DTR/RTS/BREAK-via-`mbregistryStream` reset
  branch) implements it for real. No other `relayBridger.ts` behavior
  changed; its own test suite (55 tests across this file plus the
  mbregistry-adjacent suites) passes unmodified.
- **`kind` (`"serial"` vs `"relay"`) is threaded through
  `createMbregistryStream`**, not left to a single default: the
  top-level `"mbregistry"` transport case (a direct board connect) uses
  `"serial"`; the `radio`/`mbrelay`-riding-`mbregistry` relay-physical
  case uses `"relay"` — matching `MbregistryStreamOptions.kind`'s own
  documented meaning (ticket 003).
- Testing used a fake `createMbregistryStream` factory returning a
  shared `FakeByteStream`/`RelayByteStream`, per the ticket's own
  Testing Plan — no real `MbregistryClient` or socket anywhere in
  `connector.test.ts`.

## Implementation Plan

- **Approach**: extend the existing exhaustive `switch (transport)`
  blocks in `connector.ts` (each already has a `default: never`
  exhaustiveness check, so the TypeScript compiler itself forces every
  call site to be updated — treat compiler errors from this ticket's
  `Transport` union change as a checklist).
- **Files to modify**: `packages/host/src/connect/connector.ts`,
  `packages/host/src/connect/connector.test.ts`,
  `packages/host/src/store/index.ts` (`Transport` union gains
  `"mbregistry"`).
- **Testing plan**: extend `connector.test.ts` with `mbregistry` and
  relay-via-mbregistry cases using ticket 003's fake-server harness (or a
  fake `createMbregistryStream` factory for pure connector-level unit
  tests, matching how existing tests fake `createSerialStream`/
  `createTcpStream`).
- **Documentation updates**: none beyond code comments; sprint.md already
  documents this as part of the approved architecture.
