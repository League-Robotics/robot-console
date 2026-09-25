---
id: '004'
title: 'Connector integration: mbregistry transport, exclusivity, relay physical resolution'
status: open
use-cases: [SUC-004]
depends-on: ['001', '003']
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

- [ ] A `links` row with `transport: "mbregistry"` connects through
      `connectAndIdentify` exactly like a `usb`/`wifi` row does today
      (banner identify, `deviceId`/`kind`/`owned` bookkeeping, placeholder
      merge — all unchanged code paths downstream of `buildStreamPlan`).
- [ ] `resolveExclusivity` for `mbregistry` never calls
      `acquireBoardOwner`/`acquireRelayLease` — verified by a test
      asserting no `board_owner`/`relay_leases` row is written.
- [ ] A `radio`/`mbrelay`-address link whose `relayLinkId` resolves to an
      `mbregistry`-transport row opens its relay hop through
      `mbregistryStream`, not a parse error.
- [ ] Existing `connector.test.ts` cases for `usb`/`wifi`/`mbserial`/
      `radio`/`mbrelay` (with a `usb`/`mbrelay` relay physical) are
      unmodified and still pass.
- [ ] A malformed `mbregistry` address (missing `endpoint`/`uid`) fails
      with the same descriptive-`Error`-then-`recordFailure` pattern
      every other transport uses.

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
