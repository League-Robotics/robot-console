---
id: '005'
title: 'protocol: v6/session.ts (ack/nack sequencing, retransmit)'
status: done
use-cases:
- SUC-002
depends-on:
- '004'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# protocol: v6/session.ts (ack/nack sequencing, retransmit)

## Description

Build `packages/protocol/src/v6/session.ts`, the reliability layer on
top of `v6/codec.ts` (ticket 004). Per `sprint.md`'s Architecture and
`docs/design/specification.md` §3.5, this mirrors the firmware's
`expectedNext_` state machine:

- `ack N` → `seq = N`.
- `nack N` → `seq = N-1`. **Get this arithmetic exactly right**: `nack`
  carries the *next-expected* sequence number, not the *last-good* one.
  Confusing these two was a real logged bug in a sibling repo — write an
  explicit named test asserting `nack N` sets `seq` to `N-1`, not `N`, so
  a future edit that gets this backwards fails a test immediately rather
  than failing silently against real hardware.
- A retransmit **must reuse its original id** — assigning a fresh id to
  a retransmitted frame reads to the firmware as a gap in the sequence
  and stalls the stream. The session layer's retransmit path must look
  up (or be handed) the original frame's id, not generate a new one.
- Only the 11 verbs `GET SET TLM STOP RUN WHEELS_X WHEELS_V MOVE_X
  MOVE_V GO_TO_R GO_TO_W` carry an id at all. Every other verb — notably
  `HELLO`, `?`, `STATUS`, and `PING` — is sent without an id and is
  outside the ack/nack sequence entirely; the session layer must not try
  to apply sequence tracking to those.
- `HELLO` resets the sequence to 1. Because of this, `HELLO` must
  **never** be used by this module (or by `UsbSerialLink` in ticket 008)
  as a health check on an already-live session — sending it mid-session
  would reset sequencing out from under any in-flight id-bearing
  command. Use `PING` or `STATUS` for liveness checks instead; this
  ticket should make that misuse structurally awkward if practical
  (e.g. a distinctly-named method for the initial connect-time `HELLO`
  versus an ongoing-liveness check), not just documented in a comment.

Check behavior against `radio-robot-lib/src/host/robot_v6/reliability.py`
and relevant ack/nack lines in
`vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` — reference only,
not a line-for-line port.

## Acceptance Criteria

- [ ] `ack N` sets the session's tracked sequence to exactly `N`.
- [ ] `nack N` sets the session's tracked sequence to exactly `N-1`
      (explicit named test distinguishing this from the wrong,
      last-good interpretation).
- [ ] A retransmitted frame reuses its original id; the session API
      does not allow constructing a retransmit with a freshly-generated
      id.
- [ ] Only the 11 named verbs are treated as id-bearing; sending
      `HELLO`/`?`/`STATUS`/`PING` (or any other verb) does not consume
      or expect a sequence id.
- [ ] Sending `HELLO` resets the tracked sequence to 1.
- [ ] The API surface makes the "don't use HELLO as a mid-session health
      check" rule structurally clear (e.g. distinctly named connect vs.
      liveness-check methods), and this is called out in a code comment
      at the `HELLO`-handling site.
- [ ] Relevant ack/nack cases from `golden_vectors.txt` produce the
      expected sequence-state transitions.
- [ ] All tests run under `npm test` with no hardware attached.

## Testing

- **Existing tests to run**: `npm test` (protocol suite from prior
  tickets, including ticket 004's codec, continues passing).
- **New tests to write**: `ack`/`nack` arithmetic (including the
  explicit `nack N → seq = N-1` named case), retransmit-reuses-id, the
  11-verb-only id rule (positive and negative cases), and the
  `HELLO`-resets-sequence case.
- **Verification command**: `npm test -- packages/protocol`.

## Implementation Plan

**Approach**:
1. Read `radio-robot-lib/src/host/robot_v6/reliability.py` and the
   ack/nack lines in `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` before implementing.
2. Define the session state (current sequence number, table of
   in-flight id-bearing frames pending ack for retransmit purposes).
3. Implement `onAck(n)`/`onNack(n)` per the rules above, with the
   `nack` case implemented and tested first given its bug history.
4. Implement the id-bearing-verb allowlist (the 11 named verbs) as an
   explicit constant, and gate id assignment/expectation on it.
5. Implement the retransmit path, sourcing the id from the original
   frame record rather than generating a new one.
6. Implement the `HELLO`-resets-sequence behavior and the distinctly-
   named connect-vs-liveness-check API split described above.
7. Add tests, including any applicable golden-vector ack/nack lines.

**Files to create**:
- `packages/protocol/src/v6/session.ts`
- `packages/protocol/src/v6/session.test.ts`

**Files to modify**: none.

**Testing plan**: `npm test` from the repo root.

**Documentation updates**: none beyond the in-code comment on the
`nack`-arithmetic and `HELLO`-is-not-a-health-check rules, both called
out above because they are documented sources of real bugs.
