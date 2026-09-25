---
id: '003'
title: 'mbregistryStream adapter: lock, stream, BREAK/DTR/RTS frames'
status: open
use-cases: [SUC-004, SUC-005, SUC-006]
depends-on: ['001']
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbregistryStream adapter: lock, stream, BREAK/DTR/RTS frames

## Description

Build `mbregistryStream` (new,
`packages/host/src/link/adapters/mbregistryStream.ts`, sibling to
`serialStream.ts`/`tcpStream.ts`): a `ByteStream` implementation (see
`link/LineLink.ts`'s `ByteStream` interface) backed by an mbregistry
`lock` + `stream` session, per sprint.md's Design Rationale ("a new
`ByteStream` adapter, not a `LineLink` transport of its own").

`open(signal)`:
1. Connect to the device's `endpoint` (or the local instance's own
   remote TCP port on `127.0.0.1` for a local device — the local-socket
   `stream` op, mbtools 008-004, is not yet landed; wire this so
   switching to it later is a one-place change, e.g. one small
   `resolveStreamTarget(device)` function this module calls).
2. Send `{"op":"lock","uid":...,"kind":"serial","label":...}` — label is
   this console's own identity (instance name / "robot-console"), for
   display only.
3. On `{"ok":false,"code":"locked",...}`: reject `open()` with an `Error`
   whose message is `"in use by <holder.label>"` when `holder.label` is
   present, else the plain `"in use"` — this flows straight into the
   connector's existing `recordFailure`/`state_reason` path with **no**
   new UI code (sprint.md Design Rationale). When `holder.since` is also
   present and old enough to read as stale (a fixed display threshold,
   not an enforced timeout), append the exact
   `mbregistry unlock --force <name>` hint naming the holder's host —
   SUC-006. Missing `label`/`since` (registry predates mbtools 008-002)
   must degrade gracefully — no `undefined` in the message, no crash.
4. On lock success, send `{"op":"stream","uid":...}`; after `{"ok":true}`
   the connection switches to binary frames — implement using mbtools's
   documented wire format directly (`[1-byte type][4-byte BE
   length][payload]`, types `DATA=0x01`/`BREAK=0x02`/`SET_DTR=0x03`/
   `SET_RTS=0x04`/`CLOSE=0x05` — see `mbtools/src/mbtools/registry/
   stream_frame.py` for the authoritative encode/decode; do not
   reimplement from the doc prose alone, cross-check field order/sizes
   against that module).

Expose `sendBreak()`/`setDtr(value)`/`setRts(value)` as extra methods
alongside the plain `ByteStream` surface (interface extension, not a
separate class — sprint.md Design Rationale, "Consequences"), so ticket
006 (`relayBridger`) can call them on the same locked connection instead
of opening a second one.

`close()`: send `CLOSE` if still connected, then close the socket —
releases the lock (mbregistry releases on connection close per
`docs/design/registry-api.md`'s "Locking and connection lifetime").

## Acceptance Criteria

- [ ] `open()` on an unlocked device succeeds and the resulting
      `ByteStream` carries `DATA` frames both directions, indistinguishable
      to `LineLink` from `serialStream`/`tcpStream`.
- [ ] `open()` on an already-locked device rejects with `"in use by
      <label>"` when a label is present.
- [ ] `open()` on an already-locked device with no `holder.label`
      rejects with plain `"in use"` — no `undefined` substring anywhere.
- [ ] A stale-looking lock's rejection message includes the exact
      `mbregistry unlock --force <name>` command and the owning host.
- [ ] `sendBreak()` sends a `BREAK` frame; `setDtr`/`setRts` send
      `SET_DTR`/`SET_RTS` with the correct one-byte payload.
- [ ] `close()` sends `CLOSE` and the socket closes; no dangling lock (a
      fake server test asserts the lock is released on disconnect).
- [ ] A malformed/oversized frame from the fake server is handled
      without crashing the adapter (mirrors `stream_frame.py`'s own
      `FrameError` cases) — surfaces as an `onClose`/`onError`, per
      `ByteStream`'s existing contract.
- [ ] All tests run against a fake JSON-lines + binary-frame server
      (per sprint.md's Test Strategy) — no real mbregistry required.

## Implementation Plan

- **Approach**: implement `ByteStream` directly (own `open`/`write`/`on`/
  `close`), using `mbregistryClient` (ticket 001) only for the initial
  `lock`/`stream` request/response exchange, then taking over the raw
  socket for binary framing itself (the client's own newline-JSON reader
  must stop consuming bytes the instant `stream`'s `{"ok":true}` arrives —
  coordinate the handoff explicitly, e.g. `mbregistryClient` exposes a
  `takeSocket()` escape hatch for exactly this case, mirroring
  `registry-api.md`'s own "permanently leaves JSON framing" language).
- **Files to create**:
  `packages/host/src/link/adapters/mbregistryStream.ts`,
  `packages/host/src/link/adapters/mbregistryStream.test.ts`,
  `packages/host/src/mbregistry/streamFrame.ts` (encode/decode, ported
  from `stream_frame.py`'s documented format, with its own unit tests) —
  or fold into `mbregistryStream.ts` if small enough; judge at
  implementation time.
- **Files to modify**: none outside new files (connector wiring is
  ticket 004).
- **Testing plan**: a fake TCP server in the test file that speaks
  `lock`/`stream` JSON then binary frames, covering every acceptance
  criterion above; a focused unit test for the frame codec against
  known-good byte sequences (mirroring `stream_frame.py`'s own test
  vectors where feasible).
- **Documentation updates**: none beyond code comments.
