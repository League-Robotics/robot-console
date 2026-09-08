---
id: '011'
title: Calibration wizards
status: roadmap
branch: sprint/011-calibration-wizards
use-cases: []
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
- id-verb-distinguishes-calibration-from-student-robots.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 011: Calibration wizards

## Goals

Give a student a working, calibrated distance and wheelbase constant they
can paste into their own MakeCode program, produced by driving the real
robot through two on-console wizards rather than by guessing constants.
This is the last sprint in the ten-sprint arc
(`clasi/sprints/004-device-model-device-types-and-two-level-navigation/issues/robot-console-two-level-ui-and-multi-transport-roadmap.md`),
and it is arguably the headline feature of the whole console — the thing
that makes it worth using in a classroom rather than a nicety. It is
sequenced last **because it is the most gated sprint in the arc, not
because it is the least valuable one**: it needs the robot page (sprint
6) and, in practice, telemetry (sprint 8) to show the student what the
robot actually did, and its own firmware precondition (§9 Q1) has been
open since project initiation. Putting the headline feature last is a
real cost, named here rather than smoothed over.

## Problem

Distance and wheelbase are physical constants (wheel-encoder ticks per
90cm, the wheelbase used to convert a turn angle to wheel travel) that
vary board-to-board and cannot be hard-coded into student programs. Today
there is no in-console way to derive them — a student would have to
compute them by hand from raw encoder counts, which is exactly the kind
of task a wizard exists to remove. UC-006 and UC-007
(`docs/design/usecases.md`) already describe the intended flow: drive to
a line, drive to a second line 90cm away, report drift; and drive a
360° turn, nudge it in against a beam pointer, report the wheelbase.

**The premise these use cases were written against has changed and this
sprint must plan against the new one, not the old one.** UC-006 and
UC-007's own "Error flows" sections still say the wizard depends on "the
cleartext `RUN:name:arg` path with no sequence id" — specification.md §9
Q3(a)/(d)'s old framing, where the v6 `RUN` verb was a stub and a typo'd
program name was indistinguishable from a dead robot because neither
produced an ack. **That is no longer accurate.** Upstream commit
`d4d8e4e` ("FUNCS lists the RUN registry; RUN replaces the cleartext
RUN: carve-out", 2026-09-07) plus follow-up `0056a64` replaced the
cleartext carve-out with an ordinary sequenced `RUN` verb and added a
`FUNCS` verb that enumerates what a board can actually run. Sprint 003's
submodule-bump ticket
(`clasi/sprints/done/003-hardware-bring-up-and-flash-verification/tickets/done/003-bump-vendor-pxt-nezha-diffdrive-past-d4d8e4e-and-reconcile-fixtures.md`)
confirmed `vendor/pxt-nezha-diffdrive` is now pinned past `d4d8e4e` (at
`85489cb`), and confirmed this repo's `session.ts` already lists `RUN`
in `SEQUENCED_VERBS` — the console's protocol model was **already**
built for the post-`d4d8e4e` wire shape before this finding surfaced.
Consequences that make this sprint materially easier than UC-006/UC-007
as currently worded suggest:

- `FUNCS` lets a wizard **discover its own availability** — check the
  registry for the program it needs — instead of feature-detecting by
  trial-and-timeout.
- `RUN` is sequenced and acked; an unregistered program name now answers
  `err 1`. "Wrong program name" is distinguishable from "dead robot" for
  the first time, closing the exact gap UC-006/UC-007's error flows
  currently describe as unsolved.

UC-006 and UC-007 need a rewrite to drop the stale "depends on the
cleartext path" framing before or during this sprint's detail-planning —
noted here so it isn't lost, not attempted in this roadmap-mode pass.

**The largest open unknown this sprint carried — whether the shipping
robot build's run registry contains anything calibration-suitable at
all — has already been answered, empirically, against real hardware.**
Sprint 003's ticket 006 ran a live `FUNCS` capture against two robot
boards (`vevov`, `gopiv`) on the bench. Over USB the full run registry
came back as 21 names: `clearestop abort tour straight cal fix arm probe
gap seed seedxy goto face pivot arc turnrate square diamond circle
infinity snake` — several of which read as calibration-suitable on their
face (`cal`, `fix`, `arm`, `probe`, `seed`, `seedxy`, `goto`, `arc`).
The same query over WiFi returned only 7 of the 21 names
(`clearestop abort tour straight cal fix arm`), truncated by an
already-filed, pre-existing bug in `pxt-nezha-diffdrive`
(`vendor/pxt-nezha-diffdrive/clasi/issues/wifi-transport-truncates-multi-line-replies.md`).
**Record this plainly: a WiFi-carried `FUNCS` result cannot be trusted
as complete, and detail-planning must query `FUNCS` over USB (or radio)
when deciding which program name each wizard drives**, not treat a
WiFi-truncated list as the ground truth.

What remains unresolved — and is **not** a finding this sprint can make
on its own — is whether any of those 21 names actually perform the
calibration *behavior* UC-006/UC-007 describe (line-seeking with a
counter reset, a controlled 360° turn) as opposed to merely sharing a
plausible name. That is a stakeholder/firmware question, not a console
question, and is one of the two blockers below.

## Solution

Two wizard flows on the robot page's Calibrate tab, both ending in a
MakeCode snippet:

1. **Distance-calibration wizard** — drive the robot forward via a
   `FUNCS`-discovered `RUN` program until it detects a first black line
   (zeroing a distance counter), continue to a second line a known 90cm
   away, and report how far the robot's internal counter thought it had
   driven versus the known distance. Emit a MakeCode snippet carrying the
   calibrated distance constant.
2. **Rotation-calibration wizard** — drive the robot via `RUN` to attempt
   a full 360° turn while a front-mounted beam pointer marks its actual
   heading; on-screen nudge controls (small forward/back turn
   increments, write-paced so nudges cannot overrun the link) let the
   student walk the turn in until the beam pointer returns to its
   starting orientation, dialling in the wheelbase parameter. Emit a
   MakeCode snippet carrying the calibrated wheelbase constant.

Both wizards query `FUNCS` first and refuse to start — with a clear,
non-alarming "this robot doesn't support calibration yet" message,
rather than a timeout — if the program they need isn't in the registry.
Both use the now-sequenced, acked `RUN` verb, so a wrong/missing program
name surfaces as `err 1` rather than silence, and a genuinely
unresponsive robot is distinguishable from that. Snippet emission is
client-side text generation from the wizard's final measured
constant(s) — no new wire verb.

## Success Criteria

- A student can run the distance wizard against a real robot and end
  with a MakeCode snippet reflecting a plausible, real-world calibrated
  distance constant.
- A student can run the rotation wizard against a real robot, using
  nudge controls, and end with a snippet reflecting a plausible
  calibrated wheelbase constant.
- Each wizard fails clearly (never emits a bogus calibration) when: the
  needed `RUN` program isn't in `FUNCS`'s list; the robot never detects
  the first line within a timeout; or the `RUN` call itself errors.
- Nudge commands are paced so a student mashing the buttons cannot
  overrun the link.

## Scope

### In Scope

- Distance-calibration wizard: line-seek drive, counter zero, second-line
  drive, drift report, per UC-006.
- Rotation-calibration wizard: 360° attempt, beam-pointer-guided nudge
  controls, wheelbase dial-in, per UC-007.
- Nudge controls with correct write pacing (reusing sprint 6's pacing
  discipline, not reinventing it).
- `FUNCS`-based availability discovery for both wizards (discover, don't
  feature-detect by trial).
- MakeCode snippet emission for both wizards — **this is the actual
  deliverable handed to the student**, not a nice-to-have epilogue.
- Updating UC-006/UC-007's stale "depends on the cleartext `RUN:` path"
  error-flow language to match the sequenced-`RUN`/`FUNCS` reality, as
  part of detail-planning's use-case work.

### Out of Scope

- **Flashing a dedicated calibration firmware.** The calibration hex
  still does not exist (specification.md §9 Q1, unchanged and
  stakeholder-gated) and UC-002 forbids offering it as an option until
  one does. The stakeholder chose sprint 4's local-hex picker to cover
  this case instead — do not reintroduce a calibration-firmware slot
  anywhere in this sprint's design.
- Any new wire verb or protocol change — this sprint only *consumes*
  `FUNCS`/`RUN` as they now exist upstream.
- WiFi-carried calibration runs, given the WiFi `FUNCS`-truncation bug —
  detail-planning should default both wizards to USB/radio, not WiFi,
  until that upstream bug is fixed.
- Provisioning, discovery, or any transport work — those belong to
  sprints 7 and 9 and are assumed already in place.

## Stakeholder confirmations needed before detail-planning

These are blockers on **detail-planning** (`detail_sprint("010")`), not
on this roadmap entry existing:

1. **Confirm `d4d8e4e` is the intended upstream direction**, so
   specification.md §9 Q3(a) and Q3(d) can close. Sprint 003 deliberately
   left both annotated "likely closable, left open pending confirmation"
   rather than closing them unilaterally — this sprint's entire premise
   (sequenced `RUN`, `FUNCS` discovery) rests on that direction being
   confirmed as permanent, not a transitional state.
2. **specification.md §9 Q1's status** — whether a purpose-built
   calibration firmware hex will ever exist. This determines whether the
   wizards are detail-planned against a purpose-built calibration build
   or, as this roadmap entry currently assumes, against the shipping
   robot build's existing 21-name run registry (`cal`, `fix`, `arm`,
   `probe`, `seed`, `seedxy`, `goto`, `arc` and others) confirmed live by
   sprint 003's ticket 006. If a calibration hex is later supplied, this
   sprint's `FUNCS`-driven "discover what's available" design still
   applies unchanged — it would simply discover a different, and
   probably clearer, set of names.

## Test Strategy

Split, as the roadmap issue requires, into test-provable and
hardware-deferred; never check off a criterion that wasn't exercised.

**Test-provable (against a fake link):** both wizard state machines,
including failure paths — a timeout waiting for the first line must
report failure rather than emitting a bogus calibration, a `RUN` `err 1`
for a missing program must be surfaced distinctly from a timeout, and a
`FUNCS` response missing the needed program must produce a graceful
"unavailable" state rather than attempting `RUN` anyway; MakeCode
snippet generation from known constants; nudge-control write pacing
against injected fakes.

**Needs hardware, and a physical setup (the most physically demanding
sprint in the arc):** black lines on the floor for the distance wizard;
a beam pointer and a way to observe it for the rotation wizard; a robot
that moves and is reachable over USB or radio. Every actual calibration
run — both wizards end-to-end — is hardware-only and cannot be
simulated meaningfully.

## Dependencies

Depends on sprint 6 (robot page and control surface — nudge controls and
`RUN` reuse its pacing/session machinery) and, in practice, sprint 8
(telemetry, to show the student what the robot actually did during a
run). Independent of sprint 9 (WiFi) — per the WiFi `FUNCS`-truncation
finding above, WiFi is explicitly not the intended transport for
calibration runs regardless.

## Architecture

(Deferred to detail-planning — blocked on the two stakeholder
confirmations above. Not yet sized; expect at minimum "compact" given
the wizard state machines and snippet-emission logic are new, possibly
"substantial" if the calibration-hex question reopens a new firmware
target.)

### Architecture Overview

(High-level structure and component relationships, if applicable.)

### Design Rationale

(Significant decisions with alternatives considered and reasoning, if
applicable.)

### Migration Concerns

(Data migration, backward compatibility, deployment sequencing — or
"None" if not applicable.)

## Use Cases

(Deferred to detail-planning. UC-006 and UC-007 already exist in
`docs/design/usecases.md` and cover the two wizards' main flows; their
"Error flows" sections need rewriting at detail time to drop the stale
cleartext-`RUN:`-dependency language per the Problem section above.)

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

- [ ] Both stakeholder confirmations above are answered (§9 Q3(a)/(d)
      direction; §9 Q1 calibration-hex status).
- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|

Tickets execute serially in the order listed.
