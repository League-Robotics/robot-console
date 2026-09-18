---
id: '003'
title: Statistically verify WiFi discovery reliability across repeated harness runs
status: open
use-cases: [SUC-003]
depends-on: ['002']
github-issue: ''
issue: bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Statistically verify WiFi discovery reliability across repeated harness runs

## Description

019-002 was closed on a single anecdotal success (one 206ms link
creation against `tovez`) and turned out to hold only 2/10 under
019-009's repeated-run gate. This ticket exists specifically so that
mistake is not repeated: ticket 002's fix is not considered verified
until it has survived the same class of statistical test 019-009 ran —
ten or more consecutive, sequential `scripts/bench/run.sh` runs against
a property-selected WiFi-reachable owned robot, with an explicit stated
pass rate and threshold, not a single green run.

This ticket also closes the sprint's own reliability success criterion
("matching or exceeding 019-009's ten-run gate, at a pass rate high
enough to trust — not 2/10") and is this sprint's closing ticket.

**Fixture discipline**: resolve the fixture by property at run time
("an owned robot with a live WiFi path"), never by a hardcoded name.
`tigez` was that fixture as of 2026-09-18 evidence in this sprint's
issue file, but the roster has already moved multiple times during
sprint 019 (`tigez` alone: `naught.local` → `magni.local:36491`) and may
have moved again by the time this ticket executes — re-confirm before
running, and record whatever fixture was actually used.

## Acceptance Criteria

- [ ] Ten or more consecutive, sequential `scripts/bench/run.sh` runs
      are executed against a property-selected, WiFi-reachable owned
      robot, with every run's L1/L2/L3 result recorded in a table (same
      shape as `tigez-wifi-10run-summary.log`: run #, L1, L2, L3,
      reason on failure).
- [ ] The resulting pass rate is stated explicitly and compared against
      019-009's 2/10 baseline — an improvement over 2/10 alone does not
      satisfy this criterion; the closing notes must state what pass
      rate counts as "reliable enough to trust" and show the run met
      it.
- [ ] Any run invalidated by genuine bench-sharing (a foreign process
      from an unrelated session transiently holding a bench resource,
      as 019-009 saw twice) is recorded as such, with evidence that it
      was not started or signaled by this session, and excluded from
      the 10-run count — not silently omitted and not counted as a
      pass or fail.
- [ ] If the fixture roster has moved since this sprint's planning
      (expect it to have), the actual fixture(s) used and their
      addresses at run time are recorded.
- [ ] Evidence (per-run logs/reports/screenshots) is saved to the
      session scratchpad and cited by path in this ticket's closing
      notes, matching 019-009's own evidence discipline.
- [ ] If the pass rate is still not reliable enough to trust after
      ticket 002's fix, this ticket says so plainly and does **not**
      mark `completes_issue: true` behavior as satisfied — per the
      process lesson recorded in this sprint's issue file (a ticket
      whose own closing notes say verification did not pass must not
      let the issue resolve anyway). Re-open or hand back to ticket 002
      rather than closing over unmet evidence.

## Implementation Plan

**Approach**: Confirm the current WiFi-reachable robot roster and
addresses first (do not assume `tigez`/`gopiv`/`vevov` are still
reachable or in the same place). Run `scripts/bench/run.sh` ten or more
times, sequentially, recording each run's outcome the same way 019-009
did. If a run is refused outright by the harness's own exclusivity
check due to a genuinely foreign process, record it as a bench-sharing
event (not counted) and continue until ten valid runs are collected.
State the final pass rate and compare it against the 2/10 baseline.

**Files**: none expected to change in `packages/` — this ticket is
verification, not implementation. It may add or update bench evidence
scripts under `scripts/bench/` only if a gap in the harness itself is
found while running it (unlikely, per this sprint's own context: "the
three-layer harness is in good shape").

**Testing Plan**:
- **Existing tests to run**: none beyond what ticket 002 already ran
  for its own scoped changes — this ticket's own "test" is the repeated
  bench-harness run itself, not a unit/integration suite.
- **New tests to write**: none — this is a verification ticket, not an
  implementation ticket.
- **Verification command**: `scripts/bench/run.sh` (repeated, sequential
  invocations against the resolved fixture — see this codebase's bench
  harness docs for exact invocation and options).
- **Documentation updates**: none to `docs/design/`. This ticket's
  evidence lives in its own closing notes and the scratchpad log paths
  it cites.
