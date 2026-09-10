---
id: '001'
title: 'telemetry.ts: schemaless thdr/t positional decoder'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# telemetry.ts: schemaless thdr/t positional decoder

## Description

Add `packages/protocol/src/v6/telemetry.ts`, the one `packages/protocol`
module specification.md §3.6 specifies that no earlier sprint built.
It has exactly two responsibilities: remember the most recent `thdr`
line's fields (an ordered list of column names) and zip that
positionally against a `t` line's fields into a named-field record.

This module is schemaless by construction — no branching on column
count, and no knowledge of specific column names (`ox`/`oy`/`oh`/
`rotation`/`omega` or anything else). It must decode the robot's
12-column POSE and 20-column FULL headers and radio-robot-lib's
differently-named 7- and 11-column fixtures through the identical code
path. Pure logic, zero I/O — consistent with the rest of
`packages/protocol` (see `v6/codec.ts`, `v6/session.ts`).

Suggested shape (not binding — the programmer may adjust names/shape
as long as the module stays schemaless and I/O-free):
- A small class or pair of functions: one that takes a `thdr`
  `DecodedLine.fields` (`readonly string[]`) and produces a header
  (ordered column names); one that takes that header plus a `t`
  line's fields and produces `Record<string, string>` (name → raw wire
  value, unconverted).
- No unit conversion here. `ox`/`oy` (already mm), `oh` (centidegrees,
  not divided), and `rotation`/`omega` (milliradians) are consumer-side
  concerns applied only when those specific names are present in a
  given decoded record (ticket 004/005) — baking them in here would
  violate the "one decoder, no branching" constraint the moment a
  fixture without those names is decoded.
- Reject (or clearly signal) a `t` line whose field count does not
  match the currently-held header's column count, rather than zipping
  short/ragged and silently dropping or misaligning trailing columns.

## Acceptance Criteria

- [x] A single decode path zips `thdr` against `t` positionally for
      7-, 11-, 12-, and 20-column headers, with no code path that
      branches on column count.
- [x] `ox`/`oy` values pass through the decoder completely unscaled
      (a test asserts the decoded value equals the raw wire value, in
      mm, not divided or multiplied).
- [x] `oh` values pass through completely undivided (a test pins this
      — the specific historical trap — by asserting the decoded value
      is NOT divided by any factor).
- [x] `rotation`/`omega` values pass through as raw milliradians (a
      test asserts no scaling is applied).
- [x] A `t` line whose field count does not match the held header's
      column count is handled explicitly (rejected or flagged), not
      silently zipped short.
- [x] A `t` line arriving before any `thdr` has been seen is handled
      explicitly (the module surfaces "no header held" rather than
      guessing or throwing an uncaught exception).
- [x] The module has zero imports of anything I/O-related (no
      transport, no `EndpointState`, no WS types) — it is pure data in,
      data out, matching `packages/protocol`'s existing "zero I/O"
      discipline.

## Testing

- **Existing tests to run**: `npx vitest run packages/protocol` —
  confirm no regression to `codec.ts`/`session.ts` tests (this ticket
  does not touch `codec.ts`; that's ticket 002).
- **New tests to write**: `v6/telemetry.test.ts` covering — positional
  zip across 7/11/12/20-column fixtures with no branching; each of the
  three unit traps individually (a test that would fail if the trap
  were reintroduced); mismatched field-count handling; a `t` line with
  no header held yet.
- **Verification command**: `npx vitest run packages/protocol` (root
  `test` script is `vitest run`, scoped to this ticket's package per
  the per-ticket test-scoping rule; the full suite runs once at
  `close_sprint`).
