---
id: '003'
title: MbrelayLink (remote TCP relay transport, TCP_NODELAY)
status: open
use-cases:
- SUC-004
- SUC-006
depends-on:
- '002'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MbrelayLink (remote TCP relay transport, TCP_NODELAY)

## Description

Add `MbrelayLinkSpec` to `link/Link.ts`'s `LinkSpec` union: `{
transport: "mbrelay"; resourceKey: string; host: string; port: number;
channel: number; group: number }`. `LinkFactory`'s default
implementation gains a `case "mbrelay"` branch.

Create `packages/host/src/link/MbrelayLink.ts` implementing `Link` for
a TCP-connected remote relay (discovered via `_mbrelay._tcp` — the
discovery itself is sprint 008's job; this ticket only implements the
transport given a host/port). `connect()` opens a TCP socket (Node
`net.Socket`, injectable exactly like `UsbSerialLink`'s `createPort`
seam — mirror that pattern with a `createSocket` option defaulting to
real `net.connect`) and **sets `TCP_NODELAY` immediately after
connecting, before any write** (per `sprint.md`'s explicit constraint —
the command-plane handshake is latency-sensitive line-at-a-time
traffic). Then runs ticket 002's `RelayCommandPlane` over the socket,
identically to `RelayRadioLink` — reuse `RelayCommandPlane` unmodified,
do not duplicate the handshake logic.

Once in the data plane, compose `lineStream.ts`/`pacing.ts`/
`LineRouter.ts` exactly as `RelayRadioLink`/`UsbSerialLink` do.
`MbrelayLink` and `RelayRadioLink` should differ in this file only by
what supplies the paced-write/line-subscribe pair to
`RelayCommandPlane` and by the transport-open step itself (TCP connect
+ `TCP_NODELAY` vs. serial port open) — everything after the data plane
is reached is identical in shape to both.

## Acceptance Criteria

- [ ] `MbrelayLinkSpec` added to `LinkSpec`; `LinkFactory` dispatches to
      `MbrelayLink` for it.
- [ ] `connect()` opens a TCP socket to the given host/port and calls
      the fake socket's `setNoDelay(true)`-equivalent immediately after
      connect, before any write (assert call order against the fake).
- [ ] The same `RelayCommandPlane` handshake success/`!CG`-rejection/
      `!GO`-timeout tests from ticket 002 pass against `MbrelayLink`
      with a fake TCP socket substituted for the fake serial port,
      proving the shared runner behaves identically across both
      transports (parametrize or duplicate ticket 002's test suite
      against this fake, whichever keeps the two test files most
      readable).
- [ ] Once in the data plane, `identify()`/`sendCommand()`/
      `sendUnsequenced()`/`checkLiveness()` behave identically to
      `RelayRadioLink`'s (same test technique, fake TCP socket instead
      of fake serial port).
- [ ] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- link` (packages/host).
- **New tests to write**: `MbrelayLink.test.ts`, mirroring
  `RelayRadioLink.test.ts`'s structure with a fake TCP socket in place
  of a fake serial port; a `createSocket` injection seam mirroring
  `UsbSerialLink`'s `createPort`.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Add the `LinkSpec` variant first, then implement `MbrelayLink` by
copying `RelayRadioLink`'s structure and swapping the transport-open
step — the whole point of ticket 002's `RelayCommandPlane` extraction
is that this ticket should not need to touch handshake logic at all.

### Files to create/modify

- `packages/host/src/link/Link.ts` — add `MbrelayLinkSpec`, extend
  `LinkFactory`.
- `packages/host/src/link/MbrelayLink.ts` — new.
- `packages/host/src/link/MbrelayLink.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `MbrelayLink.ts`, cross-referencing
`RelayRadioLink.ts`'s doc comment rather than repeating the shared
`RelayCommandPlane`/`Link` rationale — state plainly what differs
(TCP transport, `TCP_NODELAY`) and nothing more.
