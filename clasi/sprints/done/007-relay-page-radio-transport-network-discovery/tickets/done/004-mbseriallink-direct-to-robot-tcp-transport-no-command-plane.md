---
id: '004'
title: MbserialLink (direct-to-robot TCP transport, no command plane)
status: done
use-cases:
- SUC-005
depends-on:
- '002'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MbserialLink (direct-to-robot TCP transport, no command plane)

## Description

Add `MbserialLinkSpec` to `link/Link.ts`'s `LinkSpec` union: `{
transport: "mbserial"; resourceKey: string; host: string; port: number
}` — deliberately no `channel`/`group` fields, since `_mbserial._tcp`
addresses one specific robot's serial port directly (mbdeploy `serve`),
not a shared radio channel. `LinkFactory`'s default implementation
gains a `case "mbserial"` branch.

Create `packages/host/src/link/MbserialLink.ts` implementing `Link`:
`connect()` opens a TCP socket to the given host/port (same injectable
`createSocket` seam pattern as ticket 003's `MbrelayLink`) — **no
command-plane handshake at all**. `identify()` sends `HELLO` and reads
the banner directly from the robot on the other end, exactly as
`UsbSerialLink.identify()` does over a local port. This is the
structurally smallest of the three new transports: it composes
`lineStream.ts`/`pacing.ts`/`LineRouter.ts` exactly as `UsbSerialLink`
does, with a TCP socket in place of a local serial port, and has **no**
dependency on `RelayCommandPlane` or `protocol/relay/commands.ts` at
all (see `sprint.md`'s Design Rationale for why this asymmetry with
`RelayRadioLink`/`MbrelayLink` is correct, not an inconsistency).

A negative test matters here specifically: this transport must never
send a line matching the relay command-plane grammar (`!CG`, `!MODE`,
`!ECHO`, `!GO`, `!P`) — assert this against the fake socket's
received-lines list, since a copy-paste from `MbrelayLink.ts` is the
most likely way this could regress.

## Acceptance Criteria

- [x] `MbserialLinkSpec` added to `LinkSpec` (no `channel`/`group`
      fields); `LinkFactory` dispatches to `MbserialLink` for it.
- [x] `connect()` opens a TCP socket to the given host/port with no
      handshake step of any kind — `identify()` is the very next call
      that sends anything (`HELLO`).
- [x] `identify()`/`sendCommand()`/`sendUnsequenced()`/`checkLiveness()`
      behave identically to `UsbSerialLink`'s (same test technique, fake
      TCP socket standing in for the serial port).
- [x] A negative test asserts no line matching the relay command-plane
      grammar (`!CG`, `!MODE`, `!ECHO`, `!GO`, `!P`) is ever sent by
      this transport.
- [x] `MbserialLink.ts` has no import from `RelayCommandPlane.ts` or
      `protocol/relay/commands.ts` — enforced by the negative test above
      plus a plain source-level check (grep or an explicit assertion in
      the test file), following the precedent
      `RobotPage.transportBlind.test.ts` set for checking a structural
      property directly rather than trusting review alone.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- link` (packages/host).
- **New tests to write**: `MbserialLink.test.ts`, mirroring
  `UsbSerialLink.test.ts`'s structure with a fake TCP socket; the
  negative "no command-plane grammar" assertion described above.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Depends only on ticket 002 (for the `LinkSpec`/`LinkFactory`
extension pattern and the injectable-socket precedent `MbrelayLink`
will also use — implementable in parallel with ticket 003 once ticket
002 lands, since neither depends on the other). Copy `UsbSerialLink.ts`'s
structure, not `RelayRadioLink.ts`'s or `MbrelayLink.ts`'s — this
transport has no handshake step to inherit from either.

### Files to create/modify

- `packages/host/src/link/Link.ts` — add `MbserialLinkSpec`, extend
  `LinkFactory`.
- `packages/host/src/link/MbserialLink.ts` — new.
- `packages/host/src/link/MbserialLink.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `MbserialLink.ts` stating plainly, up front, that
this transport has no command plane and why (`_mbserial._tcp` addresses
one robot's serial port directly, unlike `_mbrelay._tcp`'s pooled radio
relay) — this is the one fact a future contributor is most likely to
get wrong by analogy by copy-paste from `MbrelayLink.ts`.
