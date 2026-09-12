---
id: '005'
title: 'LineLink core: state machine, pacer, reassembler, router, identify'
status: done
use-cases:
- SUC-001
depends-on:
- '004'
github-issue: ''
issue: rearch-04-linelink-core-replaces-four-link-classes.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# LineLink core: state machine, pacer, reassembler, router, identify

## Description

Build `packages/host/src/link/LineLink.ts` (~250 lines): the state
machine, `WritePacer`, `LineReassembler`, `LineRouter`, listener sets,
`identify()` with a banner wait that does **not** drop other lines,
`close()`, `onClose(reason)`, and an optional
`preamble(stream, signal)` hook. The constructor takes a `ByteStream`
adapter (`{open(signal), write(bytes, cb), on(data|error|close),
close()}`) — this ticket builds the core against a fake `ByteStream`
test harness; real adapters (serial/TCP) are ticket 006.

This is a new module living alongside the four existing link classes
(`UsbSerialLink`, `RelayRadioLink`, `MbrelayLink`, `MbserialLink`),
which are **not** touched or deleted this sprint — they keep running
unchanged until sprint 015's connector switches over (see `sprint.md`
Design Rationale, "LineLink ships as a new, parallel module").

## Acceptance Criteria

- [x] One fake `ByteStream` harness drives the core suite: connect /
      second connect refused / identify banner / identify null on
      timeout / identify null on closed link (no rejection) / lines
      during identify still routed / ack-nack resend ordering / close
      idempotent / `onClose` fires on stream close without error /
      write error surfaces via `onError`.
- [x] `identify()` never rejects: returns `null` on closed/timeout;
      re-entrant calls share one wait.
- [x] `connect({timeoutMs, signal})` is bounded for every transport.
- [x] `WritePacer.schedule` accepts an async write and reports failures
      via a callback → `onError`.
- [x] `lineStream` has a max-buffer guard.
- [x] Uses protocol's `receive()` facade (ticket 004) for decode/classify
      instead of re-implementing the ordering.

## Testing

- **Existing tests to run**: `packages/protocol` suite (ticket 004) must
  still pass — this ticket only consumes it, doesn't modify it.
- **New tests to write**: the full fake-`ByteStream`-driven core suite
  listed in Acceptance Criteria.
- **Verification command**: `npm test -- packages/host/src/link/LineLink`

## Implementation Plan

**Approach**: Build the core as a state machine independent of any real
transport, verified entirely against a fake `ByteStream`, so its
correctness doesn't depend on (and isn't blocked by) the real adapters
in ticket 006. Consume `receive()` from ticket 004 for the wire-level
ordering rather than re-deriving it, per the module boundary in
`sprint.md`'s Architecture (linelink → protocol).

**Files to create/modify**:
- `packages/host/src/link/LineLink.ts` (new).
- `packages/host/src/link/LineLink.test.ts` (new).
- `packages/host/src/link/__fixtures__/FakeByteStream.ts` (new): the
  shared fake harness ticket 006's adapter tests also build on.

**Documentation updates**: a module-top comment on `LineLink.ts`
explaining its relationship to the four still-running old classes
(temporary coexistence, not yet wired into the old registry).
