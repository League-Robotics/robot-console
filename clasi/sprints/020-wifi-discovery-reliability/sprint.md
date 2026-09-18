---
id: '020'
title: WiFi Discovery Reliability
status: roadmap
branch: sprint/020-wifi-discovery-reliability
use-cases: []
issues:
- bench-wifi-robot-discovery-waits-for-announcement.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 020: WiFi Discovery Reliability

## Goals

Root-cause and fix the WiFi robot discovery reliability gap, then verify
it holds under repeated, sequential harness runs. Sprint 019 (tickets
002, 009) proved the *probe* is fine — a direct TCP dial to
`<name>.local:7654` and HELLO handshake succeeds reliably (206 ms link
creation, 73 ms direct probe) — but 019-009's own ten-run gate against
`tigez` measured **2 pass / 8 fail**, with Layer 2 (the host's own
WS-level session-open / live snapshot) failing in most of the failures.
The gap is between "the robot is reachable" and "a `wifi` link row
exists in the live snapshot" — not an announcement-interval timing
artifact, and not fixable by another retry. This sprint diagnoses that
gap before patching it, per 019-009's own scope note that root-causing
an intermittent async discovery race is structural work, not a
one-line fix.

This sprint is a deliberate prerequisite to the next one (shared
console host daemon + LAN discovery): that feature's own
self-advertisement and discovery story would otherwise be built and
tested on top of a mechanism currently succeeding 2 times in 10.

## Problem

`watchers/mdnsWatcher.ts` and `discovery/wifiOnDemand.ts` (019-002)
implement bounded on-demand resolution (`dns.lookup` + TCP 7654 HELLO)
for robots with no current `wifi` link, but 019-009's ten-run gate shows
the resulting link does not reliably persist into the live snapshot that
Layer 2 (WS session-open) and Layer 3 (browser-visible link row) read
from. Whether the on-demand fallback fires reliably, or fires but loses
a race with the reconciler/snapshot-write path, is unknown and is this
sprint's first job to determine.

## Solution

Diagnose first, then fix:

1. Instrument or trace the path from "on-demand probe succeeds" to
   "link row exists in the live snapshot" across
   `discovery/wifiOnDemand.ts`, `watchers/mdnsWatcher.ts`, and the
   reconciler/snapshot-write policy that consumes their output, to find
   where the 8-of-10 failures actually occur (fallback not firing;
   firing but the result being dropped or overwritten; a race with
   host-restart timing; something else).
2. Fix the identified defect at its actual location — not a broader
   rewrite, and not another retry loop layered on top of the existing
   fallback.
3. Re-run the same class of verification 019-009 ran (repeated,
   sequential `scripts/bench/run.sh` runs against a WiFi-reachable
   robot) until the pass rate is reliable, not a single anecdotal
   success.

## Success Criteria

- The diagnosis names the specific point in the discovery pipeline
  where reachability and snapshot state diverge, backed by evidence
  (logs/traces), not conjecture.
- A WiFi-reachable owned robot reliably gets a `wifi` link in the live
  snapshot within a bounded time of host start, across repeated
  sequential harness runs (target: matching or exceeding 019-009's
  ten-run gate, at a pass rate high enough to trust — not 2/10).
- The fixture is chosen by property ("a robot with a live WiFi path"),
  never a hardcoded name — two sprint-019 tickets went stale exactly
  that way, and the roster changes constantly (three moves in one
  evening during sprint 019; `tigez` itself moved to the farm mid-run
  the day this roadmap was written).

## Scope

### In Scope

- Diagnosis of the reachability-vs-snapshot gap in
  `watchers/mdnsWatcher.ts`, `discovery/wifiOnDemand.ts`, and whatever
  reconciler/snapshot-write logic sits between them.
- A targeted fix for the actual defect found.
- Verification via repeated sequential harness runs against a
  property-selected WiFi-reachable fixture (re-confirm the current
  roster and addresses before running — do not assume `tigez`,
  `gopiv`, or `vevov` are still reachable or in the same place).
- Re-examining whether the existing `relayLeaseRevocation` lease-
  takeover seam (016-004) is a reusable pattern for the on-demand link
  path, per the design direction preserved from sprint 018 ticket 012's
  retired analysis (git commit `cc0e868`) — evaluate, don't assume it
  transfers unchanged.

### Out of Scope

- The shared console host daemon, CLI, and LAN-discovery work
  (`shared-console-host-daemon-cli-and-discovery.md`) — planned as the
  next sprint, deliberately sequenced after this one so it builds on a
  fixed foundation.
- The `request_flash` MCP client-timeout issue
  (`mcp-flash-outlives-client-timeout.md`) — unrelated subsystem,
  bundled with the daemon sprint instead.
- Relay contention's *own* fix beyond evaluating the lease-takeover
  pattern's applicability here (016-004 already exists; this sprint
  does not redo that work, only considers reusing its seam).
- USB-attached and host-attached relay paths — no USB serial devices
  are attached to the bench as of this writing, so those paths remain
  unverifiable regardless of what this sprint does.

## Test Strategy

(Describe the overall testing approach for this sprint: what types of tests,
what areas need coverage, any integration or system-level testing needed.)

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
