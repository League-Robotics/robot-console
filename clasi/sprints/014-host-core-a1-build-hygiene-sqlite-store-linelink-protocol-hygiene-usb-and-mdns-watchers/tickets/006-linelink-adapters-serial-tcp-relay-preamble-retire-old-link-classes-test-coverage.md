---
id: '006'
title: 'LineLink adapters: serial, TCP, relay preamble; retire old link classes''
  test coverage'
status: in-progress
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

- [ ] Adapter tests: serial's `toCalloutPath` applied only on darwin
      (the Linux case this sprint's build-hygiene ticket already fixed
      for the old classes now also covered here); TCP sets `NODELAY`,
      honours the connect timeout, and `destroy()`s on close.
- [ ] Relay preamble aborts within one step when its `AbortSignal` fires.
- [ ] `packages/host/src/link/` line count is under 900 including tests,
      covering the four former classes' behavior.
- [ ] `RelayCommandPlane` exports `sync`/`setChannelGroup`/`go` as
      individually callable steps.
- [ ] The old `UsbSerialLink`/`RelayRadioLink`/`MbrelayLink`/
      `MbserialLink` and their tests are untouched and still pass —
      confirming coexistence, not replacement, this sprint.

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
