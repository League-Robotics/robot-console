---
id: "008"
title: "Bench verification: relay failover, sweep takeover, network transports on real hardware"
status: open
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
depends-on:
- "004"
- "006"
- "007"
github-issue: ""
issue: ""
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: relay failover, sweep takeover, network transports on real hardware

## Description

This sprint's exit gate, mirroring sprint 015 ticket 011's own bench
ticket in shape and rigor. Every prior ticket lands automated-test
evidence with fakes; this ticket is the real-hardware pass the sprint's
own Success Criteria require ("UC-015 and UC-016 pass on real hardware").

**Precondition**: the stakeholder must place a drivable robot (e.g.
`tigez`) on the bench and stop `npm run dev` before this ticket's serial
checks — same precondition as sprint 014 ticket 010 and sprint 015 ticket
011. Per sprint 015 ticket 011's own bench findings, neither `tigez` (not
advertising `_robotlink`) nor `torture` (never identified over USB) was
reachable enough during that sprint's bench pass to demonstrate a live
radio bridge or a drive — those two items are carried forward here and
are this ticket's own first-priority checks, not optional extras.

**Bench hardware**: two relays on the hub (`vevav`/`vitut`, relay
firmware), a `torture` mbrelay pool, a `gopiv` mbserial/mbflash host, and
a `tigez` robot on the network. No firmware flashing onto any board by
agents.

**Checks**:

1. **Carried from sprint 015** (this sprint's own Scope explicitly
   inherits these): (a) a robot connects and drives over USB, WiFi, and
   radio via a relay, each independently verified; (b) a radio override
   set via the UI is honored by a live relay bridge. Both require a
   drivable robot in radio range of a relay and, for (a)'s WiFi leg, a
   robot actually advertising `_robotlink`.
2. UC-015 end to end: an idle relay's card shows "idle · sweeping", a
   sweep pass records `sightings` for remembered robots, and answering
   robots get a `Radio via <relay>` row with "last checked <time>".
3. UC-016 end to end: while a sweep is running against a relay, pressing
   Connect on a robot through that relay takes it over within one probe
   (≤ 1.5 s), and after Disconnect the sweep resumes after a quiet
   period.
4. Linux failover: confirm the per-candidate reset fix (ticket 002)
   against real hardware on Linux (Docker, per `rearch-17`'s CI floor —
   tests only, not hardware access, inside the container; the hardware
   pass itself is macOS-only, same caveat as sprint 015 ticket 011).
5. `torture` (mbrelay pool) and `gopiv`/mbserial: confirm both are
   directly connectable (not only as a failover tail candidate), per
   rearch-11's own acceptance criterion, and that a bridge through
   `torture` actually reaches a robot.
6. Full `npm test` green on both macOS (native) and Linux (Docker),
   matching sprint 015 ticket 011's own precedent for this check.

## Acceptance Criteria

- [ ] A robot connects and drives over USB, WiFi, and radio through a
      relay, each independently verified on real hardware — the sprint
      015 carry-over item, resolved (not re-deferred) this time.
- [ ] A radio override set via the UI is honored by a live relay bridge
      — the other sprint 015 carry-over item, resolved this time.
- [ ] UC-015's full flow (idle → sweep → sightings → `Radio via <relay>`
      row → "last checked") is confirmed on real hardware.
- [ ] UC-016's takeover-within-one-probe flow is confirmed on real
      hardware, with an observed handback time ≤ 1.5 s.
- [ ] The Linux per-candidate reset fix is confirmed against real
      hardware (or explicitly reasoned about if Linux cannot reach the
      USB/serial devices directly — record which).
- [ ] `torture` (mbrelay) and `gopiv` (mbserial) are each directly
      connectable and a bridge through `torture` reaches a robot.
- [ ] `npm test` is green on macOS (native) and Linux (Docker).
- [ ] Any check that cannot be completed (hardware unavailable, an
      environmental gap like sprint 015's `tigez`-not-advertising
      finding) is recorded plainly with its root cause, per this
      project's own bench-ticket precedent ("record bench results
      directly in this ticket's completion notes... do not patch;
      report") — never silently marked done.

### Carried from ticket 006 (fixups required before sprint close)

- [ ] The intermittent `watchers/relaySweeper.test.ts` flake (unhandled
      "database is not open" rejection racing `store.close()` in the
      `startRelaySweeper` tests, ~1 in 5 runs) is fixed at the root —
      the sweeper's stop must await in-flight passes before the store
      closes — and the suite passes 10 consecutive runs.
- [ ] A freshly mDNS-discovered `wifi`/`mbserial` link attached to an
      owned device is promoted `discovered` → `connectable` by the
      watcher (mirroring `usbWatcher`), so the reconciler's auto-connect
      for owned WiFi robots actually fires; un-owned stays `discovered`.
      Table test in `mdnsWatcher.test.ts`.

## Implementation Plan

**Approach**: Automated suite first (fast feedback), then the bench pass,
checks in the order listed above — items 1-3 first since they are this
sprint's own named exit criterion and the sprint 015 carry-over, items
4-5 next, item 6 last (matching sprint 015 ticket 011's own ordering
rationale).

**Files to modify**: none expected — this is a verification ticket. If
the bench pass surfaces a real defect, fix it here directly if small, or
throw an exception back to the team-lead (per the sprint-planner's
exception protocol) if it is structural and needs a new ticket — do not
silently expand scope.

**Testing plan**:
- `npm test` on macOS (native) and Linux (Docker), per sprint 015 ticket
  011's own documented Docker invocation.
- Manual bench pass per the numbered checks above, with a "Bench
  evidence" section in this ticket's completion notes recording exact
  observations (device ids, timings, snapshot excerpts) — matching
  sprint 015 ticket 011's own documented format.

**Documentation updates**: none beyond this ticket's own completion notes.
If any check cannot be resolved (e.g., hardware still unavailable), add a
"What the stakeholder must do next" section, per sprint 015 ticket 011's
own precedent, rather than leaving an unexplained unchecked box.
