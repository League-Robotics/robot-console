---
id: '002'
title: Fix the located WiFi link visibility defect
status: in-progress
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Fix the located WiFi link visibility defect

## Description

Ticket 001 names the specific point where an owned, WiFi-reachable
robot's reachability diverges from its visibility in the live snapshot,
with evidence. This ticket fixes that defect at its actual location —
**this plan is deliberately written to be revised by ticket 001's
findings** rather than pre-committing to one of the sprint
architecture's candidate hypotheses. Do not start implementation until
ticket 001 is done and its finding is read.

Also required by this sprint's Scope: explicitly evaluate whether
`connect/relayLeaseRevocation.ts`'s in-process, no-schema takeover-seam
pattern (register/get/clear over an `AbortController`, rebuilt fresh on
every host restart, no `relay_leases`-style persistence) is a reusable
shape for the WiFi on-demand path — e.g. a `session-open` request for an
owned robot with no live `wifi` link triggering (and bounded-waiting on)
an immediate probe, rather than depending solely on the passive
30-second tick. This evaluation happens regardless of which defect
ticket 001 finds, and its outcome (adopted, adapted as part of the fix,
or rejected) must be recorded either way — not skipped because the fix
ended up elsewhere (e.g. purely in aging/pruning or the owned gate).

**Explicitly out of scope for this ticket**: adding a longer timeout or
another retry layer on top of the existing fallback without addressing
ticket 001's named defect. 019-009's own evidence (failure rate got
*worse*, not better, across ten consecutive runs) argues against "it's
just a slow race" — a timeout/retry change that doesn't address the
named defect does not satisfy this ticket's acceptance criteria even if
it happens to move the pass rate on a given run.

## Acceptance Criteria

- [ ] The fix addresses the specific defect ticket 001 named — the
      ticket's closing notes explain how the change closes that
      specific gap, with a citation back to ticket 001's finding.
- [ ] The `relayLeaseRevocation.ts` reuse question is explicitly
      answered in this ticket's closing notes: adopted, adapted, or
      rejected, with reasoning either way.
- [ ] No broader rewrite beyond the located defect — changes are scoped
      to the module(s) ticket 001 implicated.
- [ ] Existing passing behavior is not regressed: the passive mDNS
      `handleWifi` path, `mbserial`/`mbrelay` link handling, and
      existing aging/pruning behavior for those transports are
      unaffected unless ticket 001's finding specifically implicates
      shared code.
- [ ] Scoped unit/integration tests pass for every module touched.
- [ ] A first confirming run of `scripts/bench/run.sh` against a
      property-selected WiFi-reachable owned robot passes Layer 2 and
      Layer 3's WiFi checks (full statistical confirmation is ticket
      003's job, not this one's — one clean run here is a smoke check
      before handing off to the repeated-run gate).

## Implementation Plan

**Approach**: Read ticket 001's closing notes first. Implement the
targeted fix at the location(s) it names. If it implicates
`projection.ts`'s owned-gate timing (deviceId resolving null at
upsert-time), the fix likely means re-resolving or re-confirming
`deviceId` closer to the point the snapshot is built, or ensuring
`uniqueOwnedDeviceIdByName` is stable across the probe's async gap. If
it implicates aging/pruning, the fix likely means aligning the
on-demand path's `last_seen`/state bookkeeping with the passive path's
guarantees. If it implicates the in-flight `Set` or a Layer 2/3 read
mismatch, fix that specific mechanism. If ticket 001 finds the passive,
tick-driven trigger is fundamentally too loosely coupled to "a session
is being requested right now," implement the evaluated
`relayLeaseRevocation.ts`-style request-driven trigger from
`connect/reconciler.ts` or `sessionOps.ts` instead — but only if ticket
001's evidence supports it, not as a default.

**Files to modify** (exact set depends on ticket 001's finding —
candidates, not a commitment):
- `packages/host/src/watchers/mdnsWatcher.ts`
- `packages/host/src/store/index.ts`
- `packages/host/src/projection.ts`
- `packages/host/src/connect/reconciler.ts` and/or `sessionOps.ts` (only
  if the request-driven-trigger direction is chosen)
- `packages/host/src/discovery/wifiOnDemand.ts` (only if ticket 001
  implicates the probe itself, which 019-009's evidence argues against)

**Testing Plan**:
- **Existing tests to run**: the full test file(s) for every module
  touched (e.g. `mdnsWatcher.test.ts`, `store/index.test.ts`,
  `projection.test.ts`, `reconciler.test.ts`/`sessionOps.test.ts` if
  touched) — scoped to modules this ticket touches, not the full suite.
- **New tests to write**: a regression test that reproduces ticket 001's
  named defect against a fake backend/store (no real network/socket, per
  this codebase's existing test conventions — see
  `mdnsWatcher.test.ts`'s and `wifiOnDemand.test.ts`'s own fixtures) and
  asserts the fix closes it. This is the test that would have caught
  019-002's own incomplete fix.
- **Verification command**: scoped `npm test --workspace=@robot-console/host -- <touched module test files>`, plus one manual `scripts/bench/run.sh` pass against a property-selected WiFi-reachable robot before handing off to ticket 003.
- **Documentation updates**: if the fix changes documented behavior
  (e.g. `watchers/mdnsWatcher.ts`'s own "WiFi on-demand fallback" doc
  comment section, or `projection.ts`'s owned-gate doc comment), update
  those doc comments in the same commit — this codebase's own
  convention (see how 018-007/016-008/017-005 are cited inline in the
  modules read for this sprint's architecture). No `docs/design/`
  changes are anticipated unless the fix changes the data model (not
  expected — see sprint.md's Migration Concerns).
