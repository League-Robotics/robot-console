---
id: '003'
title: 'RelayConnectionCoordinator: resolve, connect, and fail over to the next candidate'
status: in-progress
use-cases:
- SUC-003
- SUC-005
depends-on:
- '001'
- '002'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RelayConnectionCoordinator: resolve, connect, and fail over to the next candidate

## Description

Create `packages/host/src/relay/RelayConnectionCoordinator.ts` — see
`sprint.md`'s Architecture (Step 3) and Design Rationale ("Avoiding a
tenth seam on `DeviceRegistry`") for why this is its own module rather
than more logic folded into `deviceRegistry.ts` directly: this sprint's
own architecture self-review flagged that sprint 005 had already named
`DeviceRegistry`'s eight injected seams as approaching real
god-component risk, and warned against adding a ninth/tenth by reflex.
This coordinator keeps resolution + connection + failover *policy* in
one independently-testable class that owns **no** `EndpointState`, no
`KeyedMutex`, and no wire-message shapes — it returns a plain result to
its caller (ticket 004's `DeviceRegistry` integration).

Given one candidate name (the common case: an explicit dropdown pick)
or an ordered list of candidates (the default "try first, prefer one
that answers" case), for each candidate in order:

1. **Resolve an address.** For a `relay-radio`/`mbrelay` target: call
   ticket 002's `resolveRobotAddress` (registry host/port comes from
   ticket 001's discovered `_mbrelay._tcp` service, when one exists —
   `local-derived` otherwise, which includes "no registry was ever
   discovered," per `sprint.md`'s Solution). For an `mbserial` target:
   no resolution needed — the discovered service's host/port and the
   instance name (already the robot's name) are used directly.
2. **Build the matching `LinkSpec`** (sprint 007's `RelayLinkSpec`/
   `MbrelayLinkSpec`/`MbserialLinkSpec`) and connect via sprint 007's
   `LinkFactory`.
3. **Probe liveness** via `Link.checkLiveness()` (`PING`/`STATUS`,
   never `HELLO`) with explicit retries and a timeout budget.
4. On success, return `{ link, classification, name, addressSource,
   failoverTrail }` (`addressSource` from step 1's resolution outcome,
   absent for `mbserial`; `failoverTrail` lists every candidate given
   up on before this one, empty if the first candidate succeeded).
5. On exhaustion of retries for one candidate, close whatever transport
   it opened, append it to the trail, and move to the next candidate.
   On exhaustion of the whole candidate list, resolve with a failure
   result (never throw) carrying the full trail.

Every step is driven by injected dependencies (`resolveRobotAddress`,
the discovered-services accessor, `LinkFactory`, a `Scheduler` for
retry/timeout timing mirroring `pacing.ts`'s existing `Scheduler`
seam) — this module needs zero real I/O to test.

## Acceptance Criteria

- [ ] A single-candidate call that resolves and connects successfully
      on the first attempt returns a result with an empty
      `failoverTrail`.
- [ ] A multi-candidate call where the first two candidates' liveness
      probes never succeed within their retry budget, and the third
      does, returns a result for the third candidate with a two-entry
      `failoverTrail` — all timing driven by a fake `Scheduler` (no real
      wall-clock delay in the test).
- [ ] `checkLiveness()` (never `HELLO`) is the only liveness call this
      module ever makes — asserted directly against the fake `Link`'s
      call log.
- [ ] A candidate list that exhausts entirely (every candidate's
      liveness probe fails) resolves with a failure result carrying the
      full trail — never an unresolved promise, never a thrown
      exception.
- [ ] For a `relay-radio`/`mbrelay` candidate, `resolveRobotAddress` is
      called exactly once per candidate attempt (never speculatively,
      never re-resolved mid-retry for the same candidate) and its
      outcome tag reaches the result's `addressSource`.
- [ ] For an `mbserial` candidate, `resolveRobotAddress` is never
      called — the result's `addressSource` is absent for this
      transport.
- [ ] A transport opened for a candidate that ultimately fails is
      closed before moving to the next candidate (no leaked open
      sockets/ports across failover attempts, asserted against the fake
      `Link`'s `close()` call count).
- [ ] This module has no import of anything from `deviceRegistry.ts`
      (enforced by a plain source-level check, following the precedent
      `RobotPage.transportBlind.test.ts` set) — the dependency direction
      is `DeviceRegistry` → coordinator, never the reverse.
- [ ] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- host` (packages/host).
- **New tests to write**: `RelayConnectionCoordinator.test.ts` covering
  every acceptance criterion above against fake `resolveRobotAddress`/
  discovered-services/`LinkFactory`/`Scheduler` — no real DeviceRegistry,
  no real transport, no real registry HTTP call anywhere in this file's
  tests.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Depends on tickets 001 (discovered-services shape) and 002
(`resolveRobotAddress`'s exact signature/outcome shape) landing first,
and on sprint 007's `LinkFactory`/`LinkSpec` (already merged). Build the
single-candidate resolve-and-connect path first, then layer the
multi-candidate failover loop on top of it — the single-candidate path
is failover's own degenerate one-candidate case, so no logic should be
duplicated between them.

### Files to create/modify

- `packages/host/src/relay/RelayConnectionCoordinator.ts` — new.
- `packages/host/src/relay/RelayConnectionCoordinator.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `RelayConnectionCoordinator.ts`, explicitly
cross-referencing `sprint.md`'s "Avoiding a tenth seam on
`DeviceRegistry`" Design Rationale entry so a future reader understands
why this logic lives here and not in `deviceRegistry.ts` directly —
mirrors `KeyedMutex`'s own doc-comment precedent of explaining *why* a
class exists as its own thing, not just what it does.
