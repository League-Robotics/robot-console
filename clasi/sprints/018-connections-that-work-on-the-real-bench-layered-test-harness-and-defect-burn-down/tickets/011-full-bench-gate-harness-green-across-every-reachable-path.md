---
id: '011'
title: 'Full-bench gate: harness green across every reachable path'
status: open
use-cases:
- SUC-001
depends-on:
- '004'
- '005'
- '006'
- '007'
- 008
- 009
- '010'
- '012'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Full-bench gate: harness green across every reachable path

## Description

This sprint's exit gate, mirroring the shape and rigor of sprints
015/016/017's own final bench-verification tickets. Every prior ticket
in this sprint lands its own harness evidence for its specific fix; this
ticket runs the full three-layer harness once more, across the whole
bench, to confirm nothing regressed and every path this sprint set out
to fix now passes (or is honestly recorded as environment-blocked).

**Precondition**: `npm run dev` and any other harness run stopped
(the harness's own exclusivity check, ticket 001, enforces this).

**Paths to check** (per this sprint's Success Criteria and Scope):
- USB: `tovez` (and any other USB-attached robot/relay on the bench).
- WiFi: `gopiv` and `vevov`.
- Farm mbserial: `gopiv` (via `loki`), `tigez` (via `magni`), and
  `vevov` (via `hodr`) if reachable.
- Radio via `torture`: `vevov` and `gopiv` (the two names `torture`
  reaches per this sprint's bench facts); `tovez`/`tigez` recorded as
  Layer-1-unreachable, not re-investigated.
- Radio via a host-attached relay (e.g. a USB relay bridging to a
  radio-reachable robot), per UC-016's failover path.

No firmware flashing. No motion/drive verbs — motion stays out of scope
for this whole sprint.

## Acceptance Criteria

- [ ] Full `scripts/bench/run.sh` run against the complete bench
      produces one report covering every path listed above.
- [ ] USB `tovez` passes Layer 2 and Layer 3, or is recorded as
      Layer-1-unreachable with evidence.
- [ ] WiFi `gopiv` and `vevov` pass Layer 2 and Layer 3 (ticket 007's
      fix holds up under the full run, not just its own isolated bench
      pass).
- [ ] Farm mbserial `gopiv` (via `loki`) and `tigez` (via `magni`) pass
      Layer 2 and Layer 3 (ticket 008's fix holds up).
- [ ] Radio via `torture` to `vevov` and `gopiv` pass Layer 2 and Layer
      3 (ticket 009's fix holds up); `torture` to `tovez`/`tigez` is
      recorded as Layer-1-unreachable, consistent with this sprint's
      Scope.
- [ ] Radio via a host-attached relay to a radio-reachable robot passes
      Layer 2 and Layer 3.
- [ ] Every card checked in the Layer 3 screenshots shows truthful text
      per ticket 010 (right robot name, no raw ids, correct Linked
      state).
- [ ] Any path that still fails Layer 2 or 3 (not just Layer 1) is
      thrown back to the team-lead as a defect found late, not silently
      accepted — this ticket is a gate, not a formality.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-final-report.md` run against the complete real bench;
      the full report is attached to this ticket's completion notes as
      the sprint's closing evidence, superseding each individual
      ticket's own narrower report run.

## Implementation Plan

**Approach**: no code changes expected — this is a verification ticket,
matching the precedent of sprints 015/016/017's own final bench tickets
("no files to modify expected... If the bench pass surfaces a real
defect, it is fixed here directly (small fix) or thrown back as an
exception... per the sprint-planner's exception protocol").

**Files to modify**: none expected.

**Testing plan**: the full `scripts/bench/run.sh` run is the test. If a
path that passed its own ticket's isolated bench check now fails under
the full run (e.g. a resource-contention interaction between fixes),
investigate and fix directly if small, or throw an exception if
structural.

**Documentation updates**: this ticket's own completion notes record the
full report, mirroring sprint 015/016/017's "Bench evidence" precedent,
so a future sprint has one place to see the state of every path at this
sprint's close.
