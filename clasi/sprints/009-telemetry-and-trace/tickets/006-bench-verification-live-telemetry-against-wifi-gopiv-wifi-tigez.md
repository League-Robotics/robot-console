---
id: "006"
title: "Bench verification: live telemetry against wifi-gopiv / wifi-tigez"
status: open
use-cases: [SUC-001, SUC-002, SUC-003]
depends-on: ["002", "004", "005"]
github-issue: ""
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: live telemetry against wifi-gopiv / wifi-tigez

## Description

Manual, hardware-backed verification of the whole telemetry pipeline
built in tickets 001-005, against real, already-running robots. Per
this sprint's own Test Strategy, sustained real-rate telemetry and UI
rendering performance cannot be proven by unit tests — this ticket is
that verification, done by hand against live hardware rather than
simulated.

**Why WiFi robots, not a fresh USB flash**: this sprint's own Test
Strategy documents a known blocker — no board announces after a fresh
flash, and no robot hex is obtainable through the release path — which
would ordinarily leave live verification unexercisable. That blocker is
specific to the *flash-then-announce* path. `wifi-gopiv` and
`wifi-tigez` are already flashed, already running, and reachable right
now on the dev host over WiFi (port 4795) — sprint 010's WiFi transport
does not depend on the flash-announce path at all. Because this
sprint's implementation is transport-blind by construction (see
Architecture: no transport-specific code anywhere in tickets 001-005),
verifying against a WiFi-connected robot exercises the identical
decode/store/render pipeline a USB-connected robot would use — nothing
about "watch telemetry" or "recover a missed header" is USB-specific in
what was actually built.

**Procedure** (adjust exact UI affordances to whatever ticket 002-005
actually shipped):
1. Start the dev host (`npm run dev` or the project's documented
   equivalent) so `wifi-gopiv` and/or `wifi-tigez` are discoverable/
   connectable per the existing WiFi transport (sprint 010).
2. Open a session to one of the robots on the Robot page.
3. Subscribe to telemetry (however ticket 002's host wiring triggers
   the initial `TLM` subscription — confirm against what was actually
   implemented, since this sprint's Scope does not specify the initial
   subscription trigger beyond header-recovery).
4. Confirm wheel-speed bars and the time-series chart (ticket 004)
   update live and do not visibly lag or drop the UI thread at the
   robot's real streaming rate.
5. Drive the robot (via existing drive controls) and confirm the path
   trace (ticket 005) plots a path consistent with the robot's actual
   movement, and that Clear resets it with no observable wire traffic
   for the clear action.
6. Disconnect/reconnect (or otherwise force a session restart) to
   exercise UC-009's recovery path against the real robot; confirm the
   "waiting for header" state appears and clears once telemetry resumes,
   without the console/log showing a `TLM NOW`.
7. Repeat against the second robot if time allows, to catch anything
   that was accidentally specific to one board's exact header shape.

Record what was actually observed — including any deviation from the
sprint's assumptions (e.g. if the real robot's header omits a column
ticket 004/005 expected) — rather than only checking boxes. If hardware
access is unavailable when this ticket is worked, say so explicitly
rather than checking off unexercised criteria (per this sprint's own
Test Strategy: "never check off a criterion that was not exercised").

## Acceptance Criteria

- [ ] Wheel-speed bars and time-series chart visibly update from a
      real, live robot's telemetry stream without perceptible UI lag.
- [ ] The path trace visibly reflects the robot's actual driven path
      during a manual drive session.
- [ ] Clear visibly resets the path trace with no wire command
      observed in the console log for the clear action itself.
- [ ] A forced reconnect/resubscribe exercises the "waiting for header"
      state and its recovery, observed against real hardware (not
      simulated).
- [ ] `TLM NOW` is not observed in the console log at any point during
      verification.
- [ ] Any discrepancy between what was built and what real hardware
      actually does (unexpected header columns, timing, etc.) is
      recorded plainly, not silently smoothed over.
- [ ] If hardware access turns out to be unavailable when this ticket
      is worked, that fact is recorded explicitly and no criterion
      above is checked off unexercised.

## Testing

- **Existing tests to run**: none — this is a manual bench-verification
  ticket, not an automated-test ticket. The automated suite for all of
  packages/protocol, packages/host, and packages/ui was already run
  and must be green from tickets 001-005 before starting this one.
- **New tests to write**: none (manual verification only). If a real
  discrepancy is found against live hardware, file it as a follow-up
  issue rather than silently patching scope into this ticket.
- **Verification command**: N/A (manual bench verification against
  `wifi-gopiv`/`wifi-tigez`, port 4795, on the running dev host).
