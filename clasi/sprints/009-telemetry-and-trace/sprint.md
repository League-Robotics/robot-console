---
id: 009
title: Telemetry and trace
status: roadmap
branch: sprint/009-telemetry-and-trace
use-cases: []
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 009: Telemetry and trace

## Goals

Build the one `packages/protocol` module §3 specifies that no earlier
sprint built — `v6/telemetry.ts`, the schemaless positional decoder —
and the robot-page surfaces that consume it: wheel-speed bars,
time-series charts, and a path trace with a clear action. This is
arc position 8 of the 10-sprint roadmap recorded in
`robot-console-two-level-ui-and-multi-transport-roadmap.md` (§7 maps
it to the old spec's "S4"). It delivers UC-005 (watch telemetry) and
UC-009 (recover a missed telemetry header).

**Scheduling fact, stated prominently because it is this sprint's main
planning value:** this sprint depends on sprint 4 (device model,
ref-backed WS store) and sprint 6 (robot page, drive/control over USB)
**only — not on sprint 7** (relay/radio/discovery). Telemetry over USB
is sufficient to build and verify everything in this sprint. After
sprint 6 lands, the roadmap forks into two independent tracks (6→7 and
6→8); if sprint 7 stalls on radio hardware — a real risk, since four
distinct failure modes there (wrong channel, `BOOT_RADIO_LINK` disabled
by default, relay misconfigured, robot off) all present identically as
silence — sprint 8 can be detail-planned and executed regardless. Do
not block scheduling this sprint on sprint 7's outcome.

## Problem

`packages/protocol` has no telemetry decoder yet. The robot streams
`thdr`/`t` telemetry frames at 20 Hz, but the format is **schemaless
and positional**: the `thdr` frame names the columns for a session and
each `t` frame is a bare row that must be zipped against whatever
header is currently in effect. There is no fixed shape — the robot
emits 12-column POSE and 20-column FULL variants, and radio-robot-lib
fixtures add 7- and 11-column variants — so a decoder that branches on
column count is already wrong; it must be a positional zip against the
declared header, with no hardcoded shapes.

Three unit traps are easy to get silently wrong and specification.md
§3.6 calls them out explicitly because they've bitten implementations
before:
- `ox`/`oy` are **already millimetres** — do not scale them.
- `oh` is **centidegrees** and must **not** be divided.
- `rotation`/`omega` are **milliradians** on the wire.

And there is a recovery case (UC-009): the header auto-refreshes every
20 frames so a late-joining listener recovers passively within one
refresh interval, but a client that needs it sooner (or whose passive
wait fails) must request it by issuing `TLM HDR` — **not `TLM NOW`**.
Until a client holds a header, it must not render `t` frames against a
guessed schema; it must show an explicit "waiting for header" state.
Rendering against a guessed header is the specific failure UC-009
exists to prevent.

Finally, this lands on top of sprint 4's `WsProvider` refactor to a
ref-backed store consumed via `useSyncExternalStore` with per-endpoint
selectors — a prerequisite, not incidental cleanup, because the
pre-refactor context recreated its value object every render and would
re-render every consumer on every message. At 20 Hz that is fatal.
Telemetry frames must ride their own WS message type; they must not be
folded into the full-snapshot `devices` message, which is deliberately
a complete state dump and the wrong vehicle for high-frequency data.

## Solution

(To be detailed in Detail Mode: the decoder module, its message
plumbing onto the ref-backed store, and the robot-page telemetry
sections — wheel-speed bars, time-series charts, path trace with
clear, and the header-recovery / waiting-for-header UI.)

## Success Criteria

- `v6/telemetry.ts` decodes 7-, 11-, 12-, and 20-column `thdr`/`t`
  pairs via a single positional-zip code path with no column-count
  branching.
- All three unit traps (`ox`/`oy` unscaled mm, `oh` centidegrees
  undivided, `rotation`/`omega` milliradians) are preserved exactly and
  covered by tests that would fail if any one were reintroduced
  incorrectly.
- A client with no header shows a clear "waiting for header" state and
  never renders `t` frames against a guessed schema.
- A client recovering a missed header issues `TLM HDR`, not `TLM NOW`.
- Telemetry frames ride their own WS message type, separate from the
  `devices` snapshot message, and do not blow through the existing
  500-line per-device buffer cap or the snapshot mechanism at simulated
  20 Hz.
- Wheel-speed bars, time-series charts, and a path trace (with a clear
  action) render on the robot page from decoded frames.

## Scope

### In Scope

- `packages/protocol/src/v6/telemetry.ts` — the schemaless `thdr`/`t`
  positional decoder (§3.6), covering the 7/11/12/20-column variants.
- Wheel-speed bars and time-series charts driven by decoded telemetry.
- Path trace with a clear action.
- `TLM HDR` header-recovery per UC-009, including the "waiting for
  header" state for a client with no header yet.
- Wiring telemetry as its own WS message type consumed off the
  ref-backed store from sprint 4, respecting the 500-line buffer cap
  and snapshot mechanism at 20 Hz.
- These become sections of the robot page built in sprint 6.

### Out of Scope

- Any telemetry transport other than USB. Telemetry over radio/relay
  (sprint 7) and over WiFi (sprint 9) is explicitly deferred; USB alone
  is sufficient to build and verify this sprint.
- Calibration wizards (sprint 10).
- Persisting telemetry — explicitly out of sprint 5's roster store, and
  still out here.

## Test Strategy

Most of this sprint is test-provable, because the decoder is pure
(`packages/protocol` has no I/O) and the traps are precisely
documented:
- The positional zip across all four column-count variants (7, 11, 12,
  20), proving no code path branches on column count.
- Every unit trap (`ox`/`oy` mm, `oh` centidegrees, `rotation`/`omega`
  milliradians), each with a test that would fail if the trap were
  mishandled.
- Header-recovery choosing `TLM HDR` over `TLM NOW`.
- The waiting-for-header state for a client with no header.
- Backpressure/buffer behavior at simulated 20 Hz against the 500-line
  cap and snapshot mechanism.

Needs hardware (cannot be test-proven): sustained real 20 Hz telemetry
over a live USB link, and whether the UI keeps up — a rendering
performance question tests cannot answer.

**Known blocker, noted honestly rather than papered over:** as of this
writing, no board announces after a flash
(`clasi/issues/flash-succeeds-but-board-never-announces.md`) and no
robot hex is obtainable through the release path, so live telemetry may
not be exercisable when this sprint is executed. The decoder half
(the bulk of the sprint's value) is unaffected by this blocker since it
is pure and unit-testable without hardware.

## Architecture

(Architecture for this sprint's change, sized to the change — a
one-paragraph note for a trivial sprint, a fuller write-up with
component/data-model detail for a substantial one. May read "N/A —
trivial" when the change has no architectural impact.)

### Architecture Overview

(High-level structure and component relationships, if applicable.)

### Design Rationale

(Significant decisions with alternatives considered and reasoning, if
applicable.)

### Migration Concerns

(Data migration, backward compatibility, deployment sequencing — or
"None" if not applicable.)

## Use Cases

(Use cases sized to the change — may read "N/A — trivial" for small
sprints that don't warrant new or updated use cases.)

### SUC-001: (Title)
Parent: UC-XXX

- **Actor**: (Who)
- **Preconditions**: (What must be true before)
- **Main Flow**:
  1. (Step)
- **Postconditions**: (What is true after)
- **Acceptance Criteria**:
  - [ ] (Criterion)

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|

Tickets execute serially in the order listed.
