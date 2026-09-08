---
id: '002'
title: LinkSpec extension and RelayRadioLink (local USB relay transport)
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '001'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# LinkSpec extension and RelayRadioLink (local USB relay transport)

## Description

Extend `packages/host/src/link/Link.ts`'s `LinkSpec` union with a new
`RelayLinkSpec` variant (pure data, mirroring `UsbLinkSpec`'s existing
shape): `{ transport: "relay-radio"; resourceKey: string; portPath:
string; channel: number; group: number }`. `LinkFactory`'s default
implementation gains a `case "relay-radio"` branch. This ticket takes
no position on what populates `resourceKey`/`channel`/`group` at
runtime — that is sprint 008's job (endpoint synthesis); this ticket
only defines the shape and implements the transport that consumes it.

Also extend `packages/host/src/wsMessages.ts`'s `EndpointTransport`
union from `"usb"` to `"usb" | "relay-radio" | "mbrelay" | "mbserial"`
(all three new values added in this ticket, even though only
`"relay-radio"` has a concrete `LinkSpec`/`Link` yet — this mirrors
`FirmwareSourceRef`'s own precedent of extending a union once for a
whole planned family rather than three separate one-line PRs). This is
a type-only change per this module's existing "no logic of its own"
contract; nothing constructs one of these values yet.

Create `packages/host/src/link/RelayCommandPlane.ts`: given an injected
paced-write function and a line-subscribe function (the same shape
`RelayRadioLink`/ticket-003's `MbrelayLink` already have available
internally — do not invent a new abstraction for this, reuse the
existing `(line: string) => void` write shape and `LineListener` type
from `link/Link.ts`), runs the preamble in order using ticket 001's
line-builders: `!ECHO OFF` → `!MODE RAW250` → `!CG <ch> <grp>` → `!P 7`
→ `!GO`. A `!CG` reply recognized as a rejection stops the sequence
before `!GO` is ever sent, and resolves the runner's returned promise
with a rejection (see `sprint.md`'s Design Rationale for why this
becomes a `connect()`-level rejection, not an `identify()`-level
`null`). `!GO` confirmation is awaited under an explicit timeout
(configurable, mirroring `UsbSerialLink`'s `openTimeoutMs` pattern) —
if it never confirms, the runner rejects with a timeout error rather
than hanging.

Create `packages/host/src/link/RelayRadioLink.ts` implementing `Link`
for a local USB relay: `connect()` opens the serial port (mirrors
`UsbSerialLink.connect()` exactly, including `toCalloutPath`), then
runs `RelayCommandPlane`'s handshake over it; a handshake failure
rejects `connect()` with a diagnosable message. Once in the data plane,
`identify()`/`sendCommand()`/`sendUnsequenced()`/`checkLiveness()`/
`onLine()`/`onAckNack()`/`onError()` all compose `lineStream.ts`/
`pacing.ts`/`LineRouter.ts` exactly as `UsbSerialLink` does — do not
reimplement any of that; the goal is that `RelayRadioLink` and
`UsbSerialLink` share everything except the serial-open step and the
extra handshake in `connect()`.

## Acceptance Criteria

- [x] `LinkSpec` gains `RelayLinkSpec` (`transport: "relay-radio"`,
      `resourceKey`, `portPath`, `channel`, `group`); `LinkFactory`'s
      default implementation dispatches to a new `RelayRadioLink` for
      it.
- [x] `EndpointTransport` extended to `"usb" | "relay-radio" | "mbrelay"
      | "mbserial"` in `wsMessages.ts` — type-only, no behavior change,
      `npm run build` passes across `packages/host`/`packages/ui`.
- [x] `RelayCommandPlane` sends the full preamble in order against a
      fake write/subscribe pair, and transitions to "data plane ready"
      only after `!GO` confirms.
- [x] A fake relay that rejects `!CG` produces a rejection with no `!GO`
      ever sent (assert on the fake's received-lines list).
- [x] A fake relay that never confirms `!GO` produces a timeout
      rejection under a fake scheduler (no real wall-clock delay in the
      test).
- [x] `RelayRadioLink.connect()` opens the port then runs
      `RelayCommandPlane`; a handshake failure rejects `connect()`
      (never partially succeeds into a placeholder "connected" state).
- [x] Once in the data plane, `RelayRadioLink.identify()` behaves
      identically to `UsbSerialLink.identify()` against the same kind of
      fake serial port (same test technique as
      `UsbSerialLink.test.ts`) — `HELLO`/banner round-trip, `null` on
      timeout, never throws.
- [x] `RelayRadioLink.sendCommand()`/`sendUnsequenced()`/
      `checkLiveness()` delegate to the same `Session`/`LineRouter`/
      `WritePacer` composition `UsbSerialLink` uses — no duplicated
      sequencing logic.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- link` (packages/host), full
  `npm test` before considering this ticket done since it extends a
  shared interface (`LinkSpec`/`EndpointTransport`).
- **New tests to write**: `RelayCommandPlane.test.ts` (handshake
  success, `!CG` rejection, `!GO` timeout — fake write/subscribe pair,
  fake scheduler); `RelayRadioLink.test.ts` (mirrors
  `UsbSerialLink.test.ts`'s structure and fake `SerialPortLike`,
  extended with the handshake step).
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

`LinkSpec`/`EndpointTransport` extension first (pure types, unblocks
everything else), then `RelayCommandPlane` (depends only on ticket
001's `commands.ts`), then `RelayRadioLink` (composes the command plane
plus existing `lineStream`/`pacing`/`LineRouter`).

### Files to create/modify

- `packages/host/src/link/Link.ts` — add `RelayLinkSpec`, extend
  `LinkFactory`'s default implementation.
- `packages/host/src/wsMessages.ts` — extend `EndpointTransport`.
- `packages/host/src/link/RelayCommandPlane.ts` — new.
- `packages/host/src/link/RelayCommandPlane.test.ts` — new.
- `packages/host/src/link/RelayRadioLink.ts` — new.
- `packages/host/src/link/RelayRadioLink.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comments on `RelayCommandPlane.ts` and `RelayRadioLink.ts`
matching `UsbSerialLink.ts`'s existing documentation depth — in
particular, `RelayRadioLink.ts`'s doc comment should point back at
`Link.ts`'s "no `retarget()`" section rather than repeating the
rationale.
