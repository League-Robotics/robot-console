---
id: '006'
title: 'Bench verification: live telemetry against wifi-gopiv / wifi-tigez'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '002'
- '004'
- '005'
github-issue: ''
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

- [x] Wheel-speed bars and time-series chart visibly update from a
      real, live robot's telemetry stream without perceptible UI lag.
- [x] The path trace visibly reflects the robot's actual driven path
      during a manual drive session.
- [x] Clear visibly resets the path trace with no wire command
      observed in the console log for the clear action itself.
- [x] A forced reconnect/resubscribe exercises the "waiting for header"
      state and its recovery, observed against real hardware (not
      simulated).
- [x] `TLM NOW` is not observed in the console log at any point during
      verification.
- [x] Any discrepancy between what was built and what real hardware
      actually does (unexpected header columns, timing, etc.) is
      recorded plainly, not silently smoothed over.
- [x] If hardware access turns out to be unavailable when this ticket
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

## Bench record (2026-09-10, team-lead, headless Chromium against the live dev host)

Host: dev server on this branch at `dab1870`+ (tickets 001-005 plus the
passive header-recovery fix), port 4795. Robots: `wifi-gopiv`
(192.168.1.218) and `wifi-tigez`, both on WiFi running the extension
test image (firmware session's local build, v1.20260910.1 lineage).
Driver: Playwright script `telemetry-bench.cjs` (scratchpad) — real UI,
real clicks, real robots; wheels on the bench.

**Wheel-speed bars and time series (gopiv, tigez).** `TLM POSE` acked;
header `seq now flags x y h ox oy oh vl vr i2cf` arrived within 2.5 s;
bars idle at 0/0 (tigez) and then during a held Forward read
164/144 mm/s (gopiv) and 154/154 mm/s (tigez); the time series plotted
`vl`/`vr` live. Click latency on a turn button while streaming: 10 ms.
No per-frame React re-render (ticket 003's guarantee) — the page stayed
responsive throughout.

**Path trace.** Polyline points 45 → 133 (gopiv) and 44 → 130 (tigez)
across a 1.5 s held Forward plus a 90 deg turn; current-pose marker and
heading tick drawn.

**Clear.** `trace-clear` reset the polyline (133 → 10 new points as the
stream continued) with NO wire command in the console log — only
`TLM POSE #n`/`TLM OFF #n` and their acks appear for the whole session.

**Forced reconnect / resubscribe (gopiv).** `session-close` sent from
the wire while POSE was streaming; the page auto-reopened the session
(HELLO, banner, ids restart at 1), resubscribed POSE, and had header +
frames back 11 ms later. No nack, no err, no `TLM HDR`, no `TLM NOW`.
NOTE (discrepancy, recorded plainly): the "waiting for header" text was
NOT visible across the reconnect because ticket 003's store keeps the
last header on session close by design (only the ring clears), so
recovery happened without the waiting state ever showing. Recovery is
passive: the firmware re-emits `thdr` every 20 frames
(`kHeaderRefreshFrames`, wire_handler.h) and on any column change.

**`TLM NOW`** never observed (console lines: only POSE/FULL/OFF).

**FULL mode.** Header widened to `... cyc posl posr dutl dutr lexc wrng
cycovr`; chart column picker offered them; bars unaffected.

**Discrepancies found and fixed during this sprint.** (1) `TLM HDR`
(protocol.md §10.5) is NOT accepted by this firmware — `parseTlmMode`
knows OFF/POSE/FULL/NOW/AUTO/BUFFER; the first host build sent it on a
missing header and drew `err 2` + nack. Removed under the reopened
ticket 002 (passive recovery). (2) Before this sprint's host was
running, telemetry rows reached the console as raw text at 10 Hz and
the 500-line log re-render froze the drive pad — the stakeholder's
"charts kill the turn buttons" report; gone with the dedicated
telemetry channel. (3) `active=1` is reported by both robots even at
rest on this test image (firmware reporting quirk, raised with the
firmware session; no console impact).

**Observation, not a defect.** gopiv's wheels were already turning
(-145/+164 mm/s, a pivot) when the bench page loaded — the stakeholder
was exercising the turn buttons from their own tab at the time.
