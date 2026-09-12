---
id: '004'
title: Sweep takeover within one probe, plus relay/robot projection and UI
status: open
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: rearch-10-relay-sweeper-radio-sightings.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sweep takeover within one probe, plus relay/robot projection and UI

## Description

Completes rearch-10 and is the ticket that actually satisfies UC-016's
"student connects through a relay while it is sweeping" acceptance
target (≤ 1.5 s handback). Wires ticket 002's `relayBridger` and ticket
003's `relaySweeper` together through the shared
`relayLeaseRevocation` seam:

1. A student's `session-open` (via `relayBridger`) finds the target
   relay's `sweep` lease already held.
2. `relayBridger` looks up the sweeper's registered `AbortController` in
   the revocation seam and triggers it.
3. The sweeper (already built in ticket 003) finishes its current wait
   (≤ 500 ms), releases the lease, and makes no further writes to the
   relay.
4. `relayBridger` acquires the now-free session lease and proceeds with
   the bridge — using the sighted channel/group first if the sweep had
   already recorded one for this robot.
5. On Disconnect, the relay returns to idle; after a quiet period the
   sweeper resumes.

Total observed handback time (press to bridge proceeding) must be
≤ 1.5 s (rearch-09/UC-016's own target).

This ticket also adds the projection/UI rendering `architecture.md` §7.3
and rearch-10's issue describe: the relay card shows "idle · sweeping
<name>" (while a sweep is actively probing) or "idle" (lease-free,
between passes); robot cards show a `Radio via <relay>` link row with
state and "last checked <time>" from the newest `sightings` row for that
device (`devices.lastChecked`, already a `Snapshot.devices[]` field per
architecture.md §9 — this ticket populates it from `sightings`, it does
not add a new wire field). No wire-contract change: `SnapshotRelay`
already carries `lease: "sweep" | "session" | null`; "sweeping `<name>`"
vs. plain "idle" is a UI-side label built from `lease === "sweep"` plus
knowing which candidate is currently mid-probe (either surfaced via a
small addition to `bridging`-shaped ephemeral server state, or inferred
client-side from the most recent `sightings`-driven link change — a
ticket-level UI call).

## Acceptance Criteria

- [ ] Fake relay + fake sweep: a takeover request during an in-flight
      probe releases the sweep lease within 600 ms of the abort and
      makes no further sweep writes to the relay afterward.
- [ ] End-to-end fake-relay timing test: from the takeover request to the
      bridge proceeding (session lease acquired) is ≤ 1.5 s.
- [ ] A robot the sweep had already sighted uses that sighted
      channel/group for the takeover bridge, not a re-derived default.
- [ ] After Disconnect and a quiet period, the sweeper re-acquires the
      lease and resumes sweeping (verify via the fake relay seeing
      further `!CG`/`> ID` traffic after the quiet period elapses).
- [ ] Front-page fixture test: a snapshot with `relays[].lease ===
      "sweep"` renders "idle · sweeping"; one with `lease === null`
      renders "idle"; a robot device with a recent radio sighting renders
      a `Radio via <relay>` row with "last checked <time>".
- [ ] `npx vitest run packages/host packages/ui` passes (host: sweeper/
      bridger interaction tests; ui: fixture rendering tests).

## Implementation Plan

**Approach**: This ticket is primarily integration — the individual
pieces (bridger, sweeper, revocation seam) are already built by tickets
002/003. Write the end-to-end fake-relay test first (the ≤ 1.5 s timing
acceptance criterion) since it is the sprint's own headline behavioral
target, then the UI fixture/rendering work.

**Files to create/modify**:
- `packages/host/src/connect/relayBridger.ts` (the revocation-trigger
  call on lease-acquire-failure-because-sweep-held).
- `packages/host/src/projection.ts` (`devices[].lastChecked` populated
  from `sightings`, if not already wired by ticket 003).
- `packages/ui/src/pages/RelayPage.tsx` / front-page relay card
  component (the "idle · sweeping <name>" / "idle" label).
- `packages/ui/src/pages/FrontPage.tsx` or the relevant robot-card
  component (`Radio via <relay>` row, "last checked <time>").
- UI fixtures (`packages/host/src/projection.fixtures` and/or
  `packages/ui`'s own snapshot fixtures) regenerated to cover a
  sweep-lease relay and a radio-sighted robot.

**Testing plan**:
- `connect/relayBridger.test.ts`: the takeover-during-probe and
  end-to-end timing acceptance criteria.
- `watchers/relaySweeper.test.ts`: the resume-after-quiet-period case.
- `packages/ui`: `RelayPage.test.tsx`/`FrontPage.test.tsx` fixture
  rendering assertions.
- Scoped run: `npx vitest run packages/host packages/ui`.

**Documentation updates**: none beyond this ticket's own completion notes.
