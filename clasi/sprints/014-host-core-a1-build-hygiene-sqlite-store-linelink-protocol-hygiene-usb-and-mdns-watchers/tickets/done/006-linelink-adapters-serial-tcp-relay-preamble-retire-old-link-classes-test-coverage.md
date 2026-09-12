---
id: '006'
title: 'LineLink adapters: serial, TCP, relay preamble; retire old link classes''
  test coverage'
status: done
use-cases:
- SUC-001
depends-on:
- '005'
github-issue: ''
issue: rearch-04-linelink-core-replaces-four-link-classes.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# LineLink adapters: serial, TCP, relay preamble; retire old link classes' test coverage

## Description

Build the real `ByteStream` adapters for `LineLink` (ticket 005):
`serialStream` (using `toCalloutPath`, the `SerialPortLike` seam) and
`tcpStream` (always `setNoDelay(true)`, `destroy()` on close, connect
timeout). Enhance `RelayCommandPlane` (the module already used by the
old `RelayRadioLink`/`MbrelayLink`, updated in ticket 004 to source its
reply grammar from protocol) so it also works as `LineLink`'s
`preamble()` hook: thread an `AbortSignal` through
`runRelayCommandPlane`/`waitForMatch`, and export the individual steps
(`sync`, `setChannelGroup`, `go`) for the future sweeper (rearch-10) to
drive `!CG` without `!GO`.

This ticket's tests are what demonstrate the new core's behavior
covers the four old classes' correctness (no `onClose` gap, connect
timeout, no swallowed write failures, abortable relay preamble) — the
old classes themselves are **not deleted** this sprint (that's sprint
015, once the connector is on the core).

## Acceptance Criteria

- [x] Adapter tests: serial's `toCalloutPath` applied only on darwin
      (the Linux case this sprint's build-hygiene ticket already fixed
      for the old classes now also covered here); TCP sets `NODELAY`,
      honours the connect timeout, and `destroy()`s on close.
      (`adapters/serialStream.test.ts`, `adapters/tcpStream.test.ts` —
      the latter includes both a fake-socket suite for NODELAY/destroy/
      abort assertions and one real-loopback `net.createServer(0)`
      round-trip test, closed in `afterEach`.)
- [x] Relay preamble aborts within one step when its `AbortSignal` fires.
      (`RelayCommandPlane.test.ts`'s "AbortSignal" describe block: one
      test aborts before the handshake starts, one aborts mid-step with
      `scheduler.resolveAll()` never called, proving the rejection can
      only be the abort, not the step's own timeout.)
- [x] `packages/host/src/link/` line count is under 900 including tests,
      covering the four former classes' behavior.
      **Team-lead's interpretation (recorded in the dispatch): this
      counts LineLink.ts + LineLink.test.ts + FakeByteStream.ts (ticket
      005) + adapters/* + their tests + new RelayCommandPlane.test.ts
      lines (ticket 006) — not the whole `link/` directory (the four
      old classes deliberately coexist until sprint 015).** Measured:
      LineLink.ts 591 + LineLink.test.ts 384 + FakeByteStream.ts 150
      (ticket 005) + serialStream.ts 185 + serialStream.test.ts 166 +
      tcpStream.ts 181 + tcpStream.test.ts 185 (ticket 006) + 82 new
      lines added to RelayCommandPlane.test.ts (ticket 006) = **1924
      lines total, 1024 over the 900 budget**. Ticket 005's own three
      files already total 1125 lines on their own, before any of this
      ticket's adapter/test code exists — the budget was already
      unreachable before ticket 006 started, not something this
      ticket's own additions pushed over the line. Per the dispatch's
      explicit instruction ("if it still cannot fit, report the number
      honestly and check the box with a note rather than deleting
      coverage"): no coverage was cut to chase this number, and this
      box is left unchecked with the measured count reported here for
      the team-lead's own call on whether to accept, split the budget
      per-ticket, or revisit it at sprint close.
- [x] `RelayCommandPlane` exports `sync`/`setChannelGroup`/`go` as
      individually callable steps.
- [x] The old `UsbSerialLink`/`RelayRadioLink`/`MbrelayLink`/
      `MbserialLink` and their tests are untouched and still pass —
      confirming coexistence, not replacement, this sprint.
      (Verified via `git diff` showing no changes to any of the four
      files or their four test files, and the scoped test run showing
      all their tests green alongside the new ones.)
      **Team-lead re-scope (2026-09-11):** the 900-line target comes
      from rearch-04 and is only measurable once sprint 015 deletes the
      four old link classes. Measured new surface: 1924 lines. Carried
      forward to sprint 015 as a size check on the whole `link/` dir
      after deletion; coverage was not cut to chase the number.

## Testing

- **Existing tests to run**: the four old link classes' existing test
  files (`UsbSerialLink.test.ts` et al.) must still pass unmodified,
  confirming this ticket didn't disturb the coexisting old path.
- **New tests to write**: `serialStream`/`tcpStream` adapter tests;
  relay-preamble abort test; the line-count acceptance check as a CI
  assertion if feasible, or a documented manual check.
- **Verification command**: `npm test -- packages/host/src/link`

## Implementation Plan

**Approach**: Adapters are thin (20-40 lines each per the issue) — write
each against the same fake harness pattern ticket 005 established, then
wire `RelayCommandPlane`'s abort signal and step exports, verified with
a fake relay preamble responder.

**Files to create/modify**:
- `packages/host/src/link/adapters/serialStream.ts`,
  `adapters/tcpStream.ts` (new).
- `packages/host/src/link/RelayCommandPlane.ts` (modified, not new —
  same file ticket 004 updated for grammar sourcing): add `AbortSignal`
  threading and the step exports.
- `packages/host/src/link/adapters/*.test.ts`,
  `RelayCommandPlane.test.ts` (updated for abort case).

**Documentation updates**: none beyond the module-top comment ticket 005
started; note here that adapters are the second half of that coexistence
story.
