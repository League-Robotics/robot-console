---
id: '003'
title: Statistically verify WiFi discovery reliability across repeated harness runs
status: in-progress
use-cases:
- SUC-003
depends-on:
- '002'
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

## Pre-committed methodology and interim findings (programmer, 2026-09-18, before any run data exists)

**Pass-rate threshold, committed before any of the 10 runs execute:**

- **Valid run**: a `scripts/bench/run.sh` execution that is not refused or
  invalidated by the harness's own exclusivity check and not aborted by
  this session due to a live bench-sharing hazard (see below).
- **Excluded (not counted toward the 10, recorded separately, never
  silently dropped)**:
  - Refused/skipped by the harness's own exclusivity check due to a
    genuinely foreign holder we did not start or signal.
  - Aborted by this session pre-flight because a peer's protected
    fixture (currently `tovez`, on the same broadcast domain as `gopiv`
    — see finding below) is live and the harness has no way to avoid
    dialing it.
  - `gopiv` itself confirmed off the network at Layer 1 (raw dial
    fails / not mDNS-resolvable / TCP 7654 refused) for that run —
    this is an environment fact about the fixture, not a trial of the
    discovery mechanism, and is tracked separately as "fixture
    unreachable," not counted in the pass-rate denominator (same
    treatment 019-009 gave genuine bench unreachability).
- **Pass** (counts toward the rate): Layer 1 confirms `gopiv` reachable
  over wifi **and** Layer 2 **and** Layer 3 both pass the wifi check.
- **Defect** (counts against the rate): Layer 1 confirms `gopiv`
  reachable, but Layer 2 or Layer 3 fails the wifi check — the actual
  discovery-defect signature this sprint targets.
- **Threshold to call the fix "reliable enough to trust"**: **≥9/10
  (90%)** pass, of valid, fixture-reachable runs — not merely "an
  improvement over 2/10," a decisive one. If fewer than 10 valid,
  fixture-reachable runs can be collected at all, that is its own
  plainly-stated outcome ("blocked on fixture availability"), never
  reported as if it were a measured rate.

**Finding 1 — bench-safety hazard, confirmed live, not hypothetical.**
`gopiv` (192.168.1.218) and `tovez` (192.168.4.53) are on the **same
broadcast domain** from this host (`en0`/`en1` both carry a `/21`
netmask, `192.168.0.0`-`192.168.7.255`) — "different /24" was not the
isolation anyone assumed. A passive, read-only `dns-sd -B
_robotlink._tcp local` browse (repeated at 13:28, 13:29, 13:36, 13:37)
found `tovez` continuously announcing throughout this session with zero
absence across 16 consecutive checks (a bounded 3-consecutive-clean-
window watch was started and stopped once it was clear this was
sustained presence, not a blip). `scripts/bench/layer1/index.ts`'s
WiFi-announced dial loop (`for (const { service, endpoint } of
wifiEndpoints) { ... probeWifi(...) }`, ~line 357) dials **every**
discovered `_robotlink._tcp` service unconditionally — not gated by
`known-robots.json`, ownership, or any CLI flag. `--skip-held`/
`--allow-shared-bench` do not help (both are census-at-an-instant checks
over already-*held* resources; `tovez` here is merely *discoverable*).
This is the concrete code location for the enumeration half of
`clasi/issues/bench-exclusivity-census-is-unsound.md`. Fixing it was
considered and rejected as out of this ticket's scope (same structural
gap already earmarked for sprint 021, touches shared harness code, not
a small clearly-scoped fix). No bench run was executed while this
condition held.

**Finding 2 — a relayed claim was checked, not trusted, and did not
hold up.** Two different messages, in two different formats, arrived
mid-task both claiming to relay the coordinator's word on this same
situation. One (delivered as a plain, unwrapped turn, not the format
this session's other coordinator relays use) asserted `tovez` had gone
offline and been physically moved to `192.168.4.50`, re-advertising as
`tovez-2`. A second, differently-formatted message arrived shortly
after describing a materially different situation (tovez unchanged,
still on the playfield, coordinator negotiating access directly with
the peer) with no mention of any move or rename. Per this project's own
standing practice (019-009: "the claim was verified true, not taken on
faith"), the address/rename claim was independently checked with a
fresh passive `dns-sd -B` browse before acting on it: the instance
currently announcing is still literally named `tovez robot link` — not
`tovez-2` — contradicting the first message. No action was taken on
that claim (no attempt was made to reach `192.168.4.50`, which is also
where `vevov` lives); it is recorded here as unverified/contradicted by
direct evidence rather than silently acted on or silently ignored.

**Finding 3 — `gopiv` reachability is not currently trustworthy
either.** Two checks, ~10 minutes apart, both negative: (1) `nc -z -v
-w3 192.168.1.218 7654` -> connection refused; (2) ~10 minutes later,
`dscacheutil -q host -a name gopiv.local` returned **no record at all**
(not even resolvable) and a follow-up ping failed. `lsof -nP -iTCP`
confirms no lingering connection of ours to either fixture's address at
any point. This matches ticket 002's own note that `gopiv`'s presence
is intermittent at the OS/mDNS level even sitting still on its own
field, but two-for-two negative checks spread over ten minutes is
enough to say plainly: **`gopiv`'s own reachability cannot yet be
assumed reliable enough to spend a 10-run window on** — if this
persists when runs are attempted, expect "fixture unreachable"
exclusions per the methodology above, and if most/all of the 10
attempts land there, the honest outcome is "blocked on fixture
availability," not a measured pass rate.

**Finding 2 resolved, findings 1 and 3 now decisive together
(2026-09-18, 13:42).** Independently re-verified with full,
untruncated instance names across all three relevant service types:
`_robotlink._tcp` -> `tovez robot link` only; `_mbserial._tcp` ->
`tigez`, `gopiv`, `tovez-2`; `_mbrelay._tcp` -> `torture`. Both earlier
relayed claims about `tovez`/`tovez-2` were true, about two different
service types (`_robotlink._tcp` vs `_mbserial._tcp`) — not a
contradiction, not an injection; a truncating `awk` filter on the
coordinator's own earlier browse is why the discrepancy wasn't caught
sooner. **Decisive, independently-confirmed fact: `gopiv` currently has
no `_robotlink._tcp` advertisement at all** — its WiFi link is down,
not merely flaky (the board itself is alive via `_mbserial._tcp`). The
only robot on this bench with a live WiFi path right now is `tovez`,
which this ticket must not touch. **Zero valid, fixture-reachable runs
are currently possible**, for two independent, already-documented
reasons (gopiv's WiFi is down; tovez is off-limits). Standing by per
the coordinator's explicit instruction, not attempting any
`scripts/bench/run.sh` run, until gopiv's WiFi returns or the peer
clears tovez. If neither resolves, the honest close for this ticket is
**blocked on fixture availability** — explicitly not a measured rate —
per the pre-committed methodology above.

No `scripts/bench/run.sh` run has been executed yet. Awaiting
re-dispatch per the coordinator's explicit "stop and report" — this
section is written *before* any of the 10 runs so the threshold above
cannot be read generously after the fact.

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
