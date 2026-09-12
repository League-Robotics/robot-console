---
status: in-progress
sprint: '014'
tickets:
- 014-005
- 014-006
---

# One LineLink core with serial, TCP, and relay-preamble adapters replaces the four link classes

## Description

`UsbSerialLink`, `RelayRadioLink`, `MbrelayLink`, and `MbserialLink`
(2,007 lines) are one class pasted four times: after name normalisation
`MbserialLink` differs from `UsbSerialLink` in 27 of 307 code lines,
`RelayRadioLink` in 59 of 358, `MbrelayLink` in 86 of 365
(`02-host-transport.md` §2, with a block-by-block table). The source
says so itself (`RelayRadioLink.ts:22-26`).

The shared copy also shares its defects (`02-host-transport.md` §1, §5):

- No `onClose`. All four flip `state = "closed"` on the port/socket
  `close` event without telling anyone (`UsbSerialLink.ts:437-439`,
  `MbserialLink.ts:367-369`, …). The registry keeps `sessionOpen: true`
  and emits an error every 5 s forever. This is the largest single source
  of the error storms.
- `identify()` is documented never to throw but rejects when the link is
  closed (`assertConnected()` first, `UsbSerialLink.ts:283-284`).
- No connect timeout on serial open or TCP connect (relies on the OS SYN
  timeout, 75–130 s).
- `socket.end()` instead of `destroy()` on close; with unflushed writes to
  a dead peer `close()` waits on kernel retransmit for minutes inside the
  mutex.
- Write failures are swallowed (`pacing.ts:457-459`; `write(line)` with no
  callback).
- Non-banner lines during `identify()` are dropped before `LineRouter`
  (acks lost); two concurrent `identify()` calls clobber each other.
- `MbserialLink` deliberately leaves `TCP_NODELAY` unset; it is the WiFi
  transport at a 10 ms write cadence, so Nagle adds 40–200 ms per line.
- No `AbortSignal` through `RelayCommandPlane`; a close during the
  handshake keeps writing `?` into a closed port for 8 s.

## Proposed resolution

- `packages/host/src/link/LineLink.ts` (~250 lines): state machine,
  `WritePacer`, `LineReassembler`, `LineRouter`, listener sets, `identify()`
  with a banner wait that **does not** drop other lines, `close()`,
  `onClose(reason)`, and an optional `preamble(stream, signal)` hook.
  Constructor takes a `ByteStream` adapter:
  `{ open(signal): Promise<void>; write(bytes, cb); on(data|error|close); close(): Promise<void> }`.
- Adapters (20–40 lines each): `serialStream` (uses `toCalloutPath`,
  `SerialPortLike` seam), `tcpStream` (always `setNoDelay(true)`,
  `destroy()` on close, connect timeout). Relay links are `tcpStream` or
  `serialStream` plus the `RelayCommandPlane` preamble.
- `identify()` never rejects: returns `null` on closed/timeout. Re-entrant
  calls share one wait.
- `connect({ timeoutMs, signal })` bounded for every transport.
- `RelayCommandPlane`: thread an `AbortSignal` through `runRelayCommandPlane`
  and `waitForMatch`; export the individual steps (`sync`,
  `setChannelGroup`, `go`) so the sweeper (rearch-10) can drive `!CG`
  without `!GO`.
- `WritePacer.schedule` accepts an async write and reports failures via a
  callback → `onError`.
- `lineStream`: add a max-buffer guard.
- Delete `UsbSerialLink.ts`, `RelayRadioLink.ts`, `MbrelayLink.ts`,
  `MbserialLink.ts` and their four test files once the connector
  (rearch-05) is on the core. One core test suite + per-adapter open
  tests replace them.

## Acceptance

- One fake `ByteStream` harness drives the core suite: connect / second
  connect refused / identify banner / identify null on timeout / identify
  null on closed link (no rejection) / lines during identify still routed
  / ack-nack resend ordering / close idempotent / `onClose` fires on
  stream close without error / write error surfaces via `onError`.
- Adapter tests: serial `toCalloutPath` applied only on darwin (currently
  two tests fail on Linux for asserting it unconditionally,
  `06-build-tests-history.md` §1); TCP sets `NODELAY`, honours the connect
  timeout, and `destroy()`s on close.
- Relay preamble aborts within one step when its signal fires.
- `packages/host/src/link/` line count under 900 including tests for the
  four former classes' behaviour.

## Depends on

Nothing hard; can proceed in parallel with rearch-01. rearch-05 consumes it.

## References

- `docs/design/architecture.md` §3 (linelink)
- `docs/reviews/2026-09-11/02-host-transport.md` §1, §2, §5, §6
