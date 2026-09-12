---
id: '001'
title: 'Connector: connectAndIdentify for every transport'
status: in-progress
use-cases:
- SUC-001
- SUC-003
depends-on: []
github-issue: ''
issue: rearch-05-connector-reconciler-harvester-retire-deviceregistry.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Connector: connectAndIdentify for every transport

## Description

Build `packages/host/src/connect/connector.ts`: one
`connectAndIdentify(link: LinkRow, signal: AbortSignal): Promise<Session>`
that replaces the four bespoke connect→attach→identify paths currently
duplicated across `UsbSerialLink`, `RelayRadioLink`, `MbrelayLink`, and
`MbserialLink` (dispatched today by `deviceRegistry.ts`'s
`defaultLinkFactory`, `link/Link.ts:529`).

For any `links` row, in order:
1. Acquire exclusivity: `board_owner` for a `usb` link, `relay_leases`
   for a link that rides a relay (`radio`/`mbrelay`). Release in
   `finally`, on every exit path.
2. Build a `LineLink` (sprint 014, `link/LineLink.ts`) from the row's
   `address` and the matching adapter (`serialStream.ts`/`tcpStream.ts`).
   Call `connect({timeoutMs, signal})`.
3. If the link rides a relay or mbrelay, run the command-plane preamble
   via `link/RelayCommandPlane.ts` (`sync`/`setChannelGroup`/`go`) before
   the data plane opens.
4. Send `HELLO` with the boot-window retry schedule salvaged from
   `deviceRegistry.ts`'s `identifyWithTimeout` intent; read the banner;
   classify role/program/version via `classifyBanner` (salvage
   `parseStatusReply`, `deviceRegistry.ts:1031-1053`).
5. Upsert `devices` (`owned = 1` when reached over USB) and `sessions`;
   attach the harvester (ticket 003 — stub the attach call behind a
   narrow interface this ticket defines, since the harvester module
   does not exist yet); mark the link `connected`.
6. Any failure at any step → `setLinkState(failed, reason)` with backoff
   fields (`next_retry_at`, `fail_count`); the owner/lease is released
   regardless of where the failure occurred.

Every `await` in this path must be cancellable via `signal` — cancelling
mid-connect must release the owner/lease and leave no dangling
listeners on the underlying stream.

This ticket does **not** wire the connector into the reconciler (ticket
002) or delete any old code (ticket 003) — it stands alone, tested
against the shared fake `ByteStream` harness from sprint 014
(`link/__fixtures__/FakeByteStream.ts`).

## Acceptance Criteria

- [ ] `connectAndIdentify` exists as one function covering all five
      transports (`usb`, `wifi`, `radio`, `mbrelay`, `mbserial`),
      parameterized only by the `links` row's `transport`/`address`.
- [ ] Success path: writes `devices` (with `owned=1` for USB), `sessions`,
      and `links.state = connected`.
- [ ] Failure path: writes `failed` with `next_retry_at`/`fail_count` set
      and releases the owner/lease.
- [ ] Cancellation mid-`HELLO` releases the owner/lease and leaves no
      listeners on the fake stream.
- [ ] A closed stream during identify yields `failed`, never a thrown
      or unhandled rejection.
- [ ] Relay/mbrelay links run the `RelayCommandPlane` preamble before
      HELLO; USB/WiFi/mbserial links do not.
- [ ] No SQL is issued directly — only typed `Store` operations.

## Implementation Plan

**Approach**: New module, no changes to existing code paths yet. Define
the harvester-attach seam as a narrow injectable interface
(`{ attach(session): void }`) so ticket 003 can supply the real
implementation without changing this ticket's signature.

**Files to create**:
- `packages/host/src/connect/connector.ts`
- `packages/host/src/connect/connector.test.ts`
- `packages/host/src/connect/keyedMutex.ts` (moved from
  `deviceRegistry.ts`'s `KeyedMutex`, with `.tails` pruning fixed per
  the device-model review's §7 finding; this ticket relocates and fixes
  it since the connector is its first real consumer)

**Files to modify**: none (existing code is untouched until ticket 003).

**Testing plan**:
- Unit: `connect/connector.test.ts` against the shared fake
  `ByteStream` harness — one test per acceptance criterion above, plus
  the boot-window retry and reset-between-candidates cases salvaged
  from the old registry's coverage.
- Run: `npx vitest run packages/host/src/connect`.

**Documentation updates**: none beyond the module's own doc comment
(pattern: sprint 014's `usbWatcher.ts` header comment explaining the
seam).
