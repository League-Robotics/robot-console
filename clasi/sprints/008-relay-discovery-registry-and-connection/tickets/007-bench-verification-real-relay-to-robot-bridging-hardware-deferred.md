---
id: '007'
title: 'Bench verification: real relay-to-robot bridging (hardware-deferred)'
status: open
use-cases:
- SUC-007
depends-on:
- '005'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: real relay-to-robot bridging (hardware-deferred)

## Description

Isolate every hardware-only claim from this sprint's Success Criteria
and from SUC-001/003/005 into this one ticket, per `sprint.md`'s Test
Strategy — no other ticket's acceptance criteria depend on this one
closing, and this ticket's own criteria are explicitly **not**
checkable in CI.

**Before the bench session begins**: confirm `BOOT_RADIO_LINK = true`
on whatever robot hex will be used. Per the roadmap plan, this defaults
to `false` — a stock build does not answer the radio at all, and
discovering this mid-session (rather than confirming it up front) is
exactly the failure mode that made prior bench sessions unbounded.
Record the confirmation (hex identity, build flag) in this ticket
before proceeding to the rest.

**At the bench**:
1. Connect to a robot through a local `RelayRadioLink` relay from the
   real `RelayPage`; drive it via `RobotPage`; confirm real motion.
2. Connect through a discovered `MbrelayLink` and/or `MbserialLink`
   (whichever is available on the bench's network); confirm the same.
3. With two or more robots present and one powered off (or set to the
   wrong channel/group), select "Connect" with no explicit robot name
   and confirm the default failover path visibly reports "gave up on
   X, trying Y" and lands on the answering robot — matching what
   ticket 003/005's fake-driven tests already predicted, now against
   real silence rather than a scripted one.
4. Compare `MbrelayLink` responsiveness with and without `TCP_NODELAY`
   (a temporary local patch disabling it, reverted after the
   comparison) — record whether a difference is perceptible. Either
   outcome (measurable improvement, or no perceptible difference) is an
   acceptable, honestly-reported result; this criterion is about the
   comparison having actually been made, not about a predetermined
   result.
5. Confirm the address-source disclosure chip (ticket 006) renders
   correctly against a *real* registry (if one is available on the
   bench network) in at least one of its three outcome states, and
   against a real absent-registry local relay in its neutral state.

## Acceptance Criteria

- [ ] `BOOT_RADIO_LINK` confirmed `true` on the bench hex, recorded in
      this ticket (hex identity/build flag) before the session starts.
- [ ] Real relay-to-robot bridging confirmed end to end for
      `RelayRadioLink`.
- [ ] Real relay-to-robot bridging confirmed end to end for at least
      one of `MbrelayLink`/`MbserialLink`.
- [ ] Live failover against a real partially-silent pair (or more) of
      robots confirmed: visible "gave up on X, trying Y" trail, no
      `HELLO` used (spot-checked against the console/log traffic), no
      hang.
- [ ] `TCP_NODELAY`'s effect recorded (measurable improvement, or no
      perceptible difference — either is acceptable; absence of any
      recorded observation is not).
- [ ] The disclosure chip observed in at least one real (non-fixture)
      rendering, in a state consistent with the actual registry/relay
      configuration used.

## Testing

- **Existing tests to run**: N/A — this ticket is bench verification,
  not automated test authorship. Confirm `npm test`/`npm run build`
  still pass on the branch beforehand (no code changes expected from
  this ticket beyond recording results, unless the bench run surfaces a
  real defect — if it does, that is a new issue/ticket, not silently
  folded into this one's scope).
- **New tests to write**: None expected. If the bench run reveals a
  concrete, reproducible bug, file it as a new issue rather than
  expanding this ticket's scope — mirrors sprint 003's own precedent
  for hardware-bring-up findings.
- **Verification command**: N/A (manual bench procedure).

## Implementation Plan

### Approach

Depends on ticket 005 (a working `RelayPage`/failover/chip end to end
against fakes) — this ticket is purely the hardware verification pass
once every other ticket's fake-provable criteria are already green.
Schedule the `BOOT_RADIO_LINK` confirmation as a distinct first step,
completed and recorded before the rest of the bench session, per the
roadmap plan's own instruction.

### Files to create/modify

None expected (a verification ticket, not a code ticket) — unless the
bench run surfaces a concrete defect, in which case file it separately
and note the cross-reference here.

### Testing plan

See Acceptance Criteria above — this ticket's own "testing" is the
bench procedure itself.

### Documentation updates

Record the bench findings (hex identity, `TCP_NODELAY` comparison
result, any surprises) in this ticket's own body once complete, so a
future sprint (or a re-run of this bench procedure) has a record to
compare against — mirrors sprint 003's hardware-bring-up findings
being recorded in its own tickets rather than lost to chat history.
