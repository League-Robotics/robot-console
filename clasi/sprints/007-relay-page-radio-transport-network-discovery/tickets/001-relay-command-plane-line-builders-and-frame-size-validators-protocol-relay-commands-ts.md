---
id: '001'
title: Relay command-plane line-builders and frame-size validators (protocol/relay/commands.ts)
status: done
use-cases:
- SUC-002
- SUC-003
- SUC-006
depends-on: []
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay command-plane line-builders and frame-size validators (protocol/relay/commands.ts)

## Description

Create `packages/protocol/src/relay/commands.ts` — the module sprint
004 explicitly named and deliberately deferred (see that sprint's
Design Rationale: "a module whose only purpose is to be shared by two
transports that don't exist yet, with zero consumers, is exactly the
'speculative generality' anti-pattern"). This sprint's `RelayRadioLink`/
`MbrelayLink` (tickets 002/003) are the real consumers, so building it
now is no longer speculative.

Pure, zero-I/O line-builders for the relay command-plane preamble:
`!ECHO OFF`, `!MODE RAW250`, `!CG <ch> <grp>`, `!P 7`, `!GO`, `?`. Also
export the liveness pair as data (`PING`/`STATUS` line text) — but do
**not** export any `HELLO` builder from this module; `HELLO` is only
ever sent via `Session.connect()` (existing `@robot-console/protocol`
code), never re-derived here, so there is no line-builder in this
module that could accidentally be reused as an ongoing liveness probe.

Also export the frame-size validators: `validateFrameSize(mode: "makecode"
| "raw250", payloadBytes: number): { ok: true } | { ok: false; reason:
string }` (or equivalent), with caps MAKECODE ≤16 bytes, RAW250 ≤247
bytes. A boundary-exact payload (exactly 16 or exactly 247 bytes)
succeeds; one byte over fails. This function returns a value — it never
throws and never truncates/fragments (per `docs/design/specification.md`
§6: neither is supported by the radio protocol).

`#` lines are comments in this grammar (per the roadmap plan) — if this
module exposes any comment-line helper, document that `#` lines are
never sent as commands, only ever received/ignored.

Every function in this module takes/returns plain data — no sockets, no
timers, no `Session`, no knowledge of which transport will eventually
send the line. This is what lets ticket 002's `RelayCommandPlane`
runner (host-side) compose these builders with an injected paced-write/
line-subscribe pair without this module knowing anything about pacing
or transports.

## Acceptance Criteria

- [x] `packages/protocol/src/relay/commands.ts` exports line-builders
      for `!ECHO OFF`, `!MODE RAW250`, `!CG <ch> <grp>`, `!P 7`, `!GO`,
      `?`, each returning the exact wire text (matching this project's
      existing line-ending convention in `v6/codec.ts`).
- [x] No function in this module builds a `HELLO` line — verified by a
      test asserting the module's exports contain no such builder.
- [x] `validateFrameSize` (or equivalently named export) enforces
      MAKECODE ≤16 bytes and RAW250 ≤247 bytes, tested at the exact
      boundary (16/247 succeed, 17/248 fail) for both modes.
- [x] `validateFrameSize` returns a value on failure — it never throws
      and there is no truncation/fragmentation code path anywhere in
      this module.
- [x] Every exported function is covered by a unit test with zero I/O
      (no fake sockets, no fake timers needed — everything here is a
      pure function).
- [x] The module is added to `packages/protocol/src/index.ts`'s
      barrel export, following that file's existing one-line-per-module
      pattern.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- protocol` (full protocol
  package suite, since this is a new module with no prior behavior to
  regress).
- **New tests to write**: see Acceptance Criteria — one test file,
  `packages/protocol/src/relay/commands.test.ts`, covering every
  exported line-builder's exact wire text and both frame-size
  boundaries.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Write the line-builders first (small, mirrors `v6/codec.ts`'s existing
plain-function style), then the frame-size validators. No dependency on
any other ticket in this sprint — this is the pure-data foundation
tickets 002/003 both compose.

### Files to create/modify

- `packages/protocol/src/relay/commands.ts` — new.
- `packages/protocol/src/relay/commands.test.ts` — new.
- `packages/protocol/src/index.ts` — add the barrel export.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `commands.ts` itself, matching this package's
existing per-file documentation convention (see `v6/session.ts`'s
module doc comment for the level of detail expected — in particular,
document the `HELLO`-is-a-reset-not-a-health-check rule inline, since
this is the one place a future contributor might otherwise be tempted
to add a `HELLO` builder "for completeness").
