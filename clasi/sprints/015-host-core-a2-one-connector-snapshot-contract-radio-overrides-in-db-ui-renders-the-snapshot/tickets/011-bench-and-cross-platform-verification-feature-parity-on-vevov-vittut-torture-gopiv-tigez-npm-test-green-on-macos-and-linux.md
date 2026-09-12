---
id: '011'
title: "Bench and cross-platform verification: feature parity on Vevov/Vittut/torture/gopiv/tigez, npm test green on macOS and Linux"
status: open
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
- SUC-008
- SUC-009
- SUC-010
depends-on:
- '009'
- '010'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench and cross-platform verification: feature parity on Vevov/Vittut/torture/gopiv/tigez, npm test green on macOS and Linux

## Description

This sprint's exit gate. Every prior ticket lands automated-test
evidence; this ticket is the real-hardware bench pass the plan's own
risk section calls out ("the Linux failover bug and the macOS
boot-window bug were both invisible to the existing automated tests").

**Precondition**: the stakeholder's `npm run dev` must **not** be
running during the serial bench checks (same precondition sprint 014's
ticket 010 stated) — a second process holding the port will produce
false failures that look like regressions.

**Bench hardware**: two micro:bits on this Mac's hub — Vevov (SWD name
`vevav`, relay firmware) and Vittut (`vitut`, relay firmware); a
`torture` mbrelay and a `gopiv` mbserial/mbflash host and a `tigez`
robot advertising on the bench network via mDNS. No firmware flashing
onto any board during this ticket.

**Checks**:
1. Full `04-ui.md` §1 feature-parity pass: exercise each row not
   already covered by an automated test (from tickets 007-009's parity
   report) manually against real hardware; record pass/fail per row.
2. Placeholder-merge (SUC-003) on real hardware: confirm a robot seeded
   by the sprint-014 `known-robots.json` import collapses to one
   `devices` row on first real USB identification (bench evidence
   precedent: `vevov`/`vittut` in the 2026-09-11 dump).
3. USB, WiFi, and radio-relay connect/identify/drive for at least one
   robot each, on macOS directly and on Linux via Docker (per
   `rearch-17`'s CI floor from sprint 014 — tests only, not hardware
   access, inside the container; the hardware pass itself is macOS-only
   since Docker cannot reach the USB/serial devices).
4. Disconnected-from-host banner: stop the host mid-session, confirm
   the banner and control-disabling, restart, confirm reconnect clears
   it.
5. Radio override end-to-end: set an override via the Configuration
   tab, confirm a relay bridge to that robot uses it.
6. `deviceRegistry.ts` and its satellites, and the four old link
   classes, are confirmed absent from the built artifact (not just
   source — check `dist/`).
7. Full `npm test` green on both macOS (native) and Linux (Docker).

## Acceptance Criteria

- [ ] Every `04-ui.md` §1 row is confirmed either by an automated test
      (cited from tickets 007-009) or by this ticket's manual bench
      pass; any row still not preserved is listed with a reason in this
      ticket's completion notes and flagged to the team-lead.
- [ ] Vevov and Vittut both identify correctly over USB with no
      duplicate `devices` rows (placeholder-merge confirmed on real
      hardware, not just the simulated test from ticket 003).
- [ ] A robot connects and drives over USB, over WiFi, and over radio
      through `torture`, each independently verified.
- [ ] The disconnected-from-host banner appears within the tab on host
      restart and clears on reconnect with a fresh snapshot.
- [ ] A radio override set via the UI is honored by a live relay bridge.
- [ ] `npm test` is green on macOS (native run) and on Linux (Docker).
- [ ] `deviceRegistry.ts`, `wifiRobotGate.ts`, `RelayConnectionCoordinator.ts`,
      and the four old link classes are absent from both source and the
      built `dist/` output.

## Implementation Plan

**Approach**: Automated suite first (fast feedback), then the bench
pass, in the order listed above. Record bench results directly in this
ticket's completion notes (pass/fail per `04-ui.md` §1 row and per
numbered check above) rather than in a separate file, matching sprint
014 ticket 010's precedent.

**Files to modify**: none expected — this is a verification ticket. If
the bench pass surfaces a real defect, it is fixed here directly (small
fix) or thrown back as an exception to the team-lead (structural issue
requiring a new ticket), per the sprint-planner's exception protocol —
do not silently expand scope for a large fix.

**Testing plan**:
- `npm test` on macOS (native).
- `npm test` on Linux via the Docker setup from `rearch-17` (sprint
  014).
- Manual bench pass per the numbered checks above.

**Documentation updates**: none beyond this ticket's own completion
notes recording the bench evidence (matching sprint 014 ticket 010's
"Bench evidence" section as precedent for format).
