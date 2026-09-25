---
id: '003'
title: 'mbregistryStream adapter: lock, stream, BREAK/DTR/RTS frames'
status: done
use-cases:
- SUC-004
- SUC-005
- SUC-006
depends-on:
- '001'
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

- [x] `open()` on an unlocked device succeeds and the resulting
      `ByteStream` carries `DATA` frames both directions, indistinguishable
      to `LineLink` from `serialStream`/`tcpStream`.
- [x] `open()` on an already-locked device rejects with `"in use by
      <label>"` when a label is present.
- [x] `open()` on an already-locked device with no `holder.label`
      rejects with plain `"in use"` — no `undefined` substring anywhere.
- [x] A stale-looking lock's rejection message includes the exact
      `mbregistry unlock --force <name>` command and the owning host.
- [x] `sendBreak()` sends a `BREAK` frame; `setDtr`/`setRts` send
      `SET_DTR`/`SET_RTS` with the correct one-byte payload.
- [x] `close()` sends `CLOSE` and the socket closes; no dangling lock (a
      fake server test asserts the lock is released on disconnect).
- [x] A malformed/oversized frame from the fake server is handled
      without crashing the adapter (mirrors `stream_frame.py`'s own
      `FrameError` cases) — surfaces as an `onClose`/`onError`, per
      `ByteStream`'s existing contract.
- [x] All tests run against a fake JSON-lines + binary-frame server
      (per sprint.md's Test Strategy) — no real mbregistry required.

## Implementation Notes (deviations from plan)

- **Local-socket-first `stream`, coordinator update mid-ticket**: mbtools
  008-004 landed `stream` on the local Unix socket/pipe (previously
  TCP-remote-API-only) while this ticket was in progress. `mbregistryClient.stream()`
  (`packages/host/src/mbregistry/client.ts`) now tries a fresh connection
  to this client's own local endpoint first for a local device, falling
  back to the remote TCP port only if that local attempt's `stream`
  request comes back `invalid_request` (an older registry). This *is* a
  change to a file outside the ticket's own new files (the plan said
  "none outside new files") — necessary because `resolveStreamTarget`'s
  "one-place change" seam lives one layer up, in what target `stream()`
  itself picks, not in `mbregistryStream.ts`.
- **`client.stream()` gained a `label` parameter** (4th, optional) — the
  original ticket-001 signature had no way to pass `lock`'s own `label`
  field, which this ticket's own acceptance criteria require.
- **Fixed a real dangling-connection/data-loss bug found while testing**:
  `client.stream()`'s handshake now reads `stream`'s own ack line off the
  raw socket directly (`performStreamHandshake`/`readRawLine`) rather
  than through the shared JSON-line reassembler, and returns any bytes
  that arrived in the very same TCP chunk as that ack (`leftover`) for
  `mbregistryStream` to feed into its frame decoder first. Without this,
  a frame the server writes immediately after its own ack (plausible on
  a fast loopback connection) could be silently dropped or corrupted by
  the string-based JSON reassembler's own `detach()`. Confirmed via the
  malformed-frame test, which failed until this fix landed. Every
  lock/stream failure path now also always tears down its own socket
  (previously a `locked` failure on the local-first attempt left a
  connection open, hanging `net.Server.close()` in tests).
- `DEFAULT_STALE_LOCK_AFTER_S` (5 minutes) is this module's own fixed
  *display* threshold — SUC-006 is explicit this is not an enforced
  timeout.

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
