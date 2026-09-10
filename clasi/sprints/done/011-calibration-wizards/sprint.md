---
id: '011'
title: Calibration wizards
status: done
branch: sprint/011-calibration-wizards
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
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

## Detail-planning findings (2026-09-10) — both roadmap blockers are resolved, and the roadmap's own Solution was wrong about how the firmware works

Both items under "Stakeholder confirmations needed before detail-planning"
below are now answered by verified evidence, not by this sprint
unilaterally closing them:

1. **§9 Q3(a)/(d) (the `d4d8e4e` direction) is confirmed as permanent.**
   Sprints 003 and 006-010 have all shipped against the sequenced,
   `FUNCS`-discoverable `RUN` this sprint's premise depends on — it is
   the console's only model at this point, not a transitional one.
2. **§9 Q1 (does a calibration hex exist) is answered: yes.** The
   calibration image is `nezha-robot-template`
   (`https://github.com/League-Robotics/nezha-robot-template`, release
   `v0.20260910.3` / extension `v1.20260910.1`, shipping `MICROBIT.hex`
   plus a sha256 manifest — the console's existing release-fetch path
   in `releases.ts` already handles this shape unchanged), and
   `ROBOT_CONSOLE_ROBOT_FIRMWARE` is now pointed at that repo. A live
   `FUNCS` against that image (this session) returned: `trace(on=0)
   counters() square() circle() calx() cala() spin(secs=20)
   line(speed=25,max_speed=60,kp=120) abort() sense() push(mm) turn(deg)
   speed(pct) m(mm) t(deg) clear() diag()` — `calx`/`cala` are the two
   calibration routines this sprint's wizards drive.

**More importantly, reading `test/calibratex.ts` and
`test/calibratea.ts` in that repo directly (this session, against a
fresh clone) shows the roadmap's own Solution section below — written
before this hex existed — described a firmware behavior these routines
do not have.** There is no front-mounted beam pointer and no on-screen
nudge control anywhere in this firmware. Both routines are fully
autonomous, self-reporting, and even self-verifying:

- **`calx`** (distance): anchors `travelCalib` to a known baseline
  (`diffDrive.setWheelCalibration(0.7878)`), creeps forward at 8 cm/s
  until a reflectance sensor sees a black line (the first of two lines
  the student lays 90 cm apart *before* the run — the only physical
  setup this wizard needs), then drives the gap and stops on the second
  line. It emits plain, unprefixed-by-any-wire-verb text lines
  (`CALX:begin ...`, `CALX:start line found`, `CALX:measured=... cm
  true=90cm error=...`, `CALX:calib=... mm/deg (was 0.7878)`,
  `CALX:diameter=... mm`, `CALX:apply
  diffDrive.setWheelCalibration(...)`) via `emitLine()` — these are not
  `SET`/`GET` traffic and carry no `#id`; on the wire they are exactly
  the kind of non-protocol text `LineRouter`'s `onUnrouted` path already
  routes into the endpoint's ordinary rx log via
  `deviceRegistry.ts`'s `link.onRawLine` handler (confirmed reading that
  handler this session — it is already wired, unconditionally, for
  every transport). The **last** `CALX:apply ...` line's text **is**
  the MakeCode snippet the student pastes — nothing needs to be
  generated from constants pulled off the wire; the firmware already
  wrote the exact line of TypeScript.
- **`cala`** (rotation): anchors `trackWidth`/`RotationalSlip` to a
  caliper-measured baseline, then spins **clockwise then
  counter-clockwise** against a black-tape cross on the floor (the only
  physical setup — no beam pointer), using one reflectance channel to
  time white-to-black edge crossings, discards a spurious first edge,
  and averages the two directions' full-turn readings into one
  corrected `RotationalSlip`. It then **re-spins both directions a
  second time with the correction applied**, as its own built-in
  verification, and reports the residual error. Its final
  `CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip,
  ...)` line is, again, the literal snippet to paste — and because
  `rotational_slip` genuinely is a `SET`/`GET`-able wire field
  (`vendor/pxt-nezha-diffdrive/src/comms/config_fields.h`, ordinal 16),
  the routine's own `CALA:begin ... b=<anchor>cm` / `CALA:measured
  b=<corrected>cm (anchor was <anchor>)` lines already give a
  before/after pair with no extra wire traffic needed to produce one.

**Consequence for this sprint's design, stated plainly: no nudge
controls, no beam-pointer integration, and no new wire verb or `SET`
call the console itself issues.** The wizard's job shrinks to: tell the
student what to lay out physically, discover `calx`/`cala` via `FUNCS`
(reusing the exact discovery `FunctionsPanel` already does), run one via
`RUN` (reusing `sendCommand`, exactly as `FunctionsPanel`'s Go button
does today), watch the endpoint's existing rx log for `CALX:`/`CALA:`
lines as they stream in (reusing the exact per-endpoint log
`CommandStrip` already reads for its `GET`-reply harvesting), and, on
the terminal `...:apply ...` line, present it verbatim as the
copy-paste snippet. This is a substantially smaller build than the
roadmap envisioned, not a larger one — see Architecture below.

UC-006 and UC-007 (`docs/design/usecases.md`) still describe the old,
wrong shape (a beam pointer, "student measures distance/angle",
dependence on the cleartext `RUN:` path) and are corrected by this
sprint's tickets (see Tickets), not rewritten here — sprint-planner's
write scope is this sprint directory, not `docs/design/`.

## Solution

Two wizard panels mounted on the robot page (`RobotPage`, alongside
`FunctionsPanel`/`ChartsPanel`/etc. — never a separate route or tab),
each a thin state machine over capabilities the page already has:

1. **Distance-calibration wizard** — shows the two-line, 90 cm setup
   instructions; is enabled once `FUNCS` (auto-requested on mount, the
   same one-shot-per-open-transition pattern `CommandStrip` already
   uses for its bare `GET`) reports `calx`; on Go, sends `RUN calx` and
   renders each `CALX:` line as it streams into the endpoint's log,
   ending in the literal `CALX:apply diffDrive.setWheelCalibration(...)`
   text as a copy-paste snippet.
2. **Rotation-calibration wizard** — shows the black-tape-cross setup
   instructions; enabled once `FUNCS` reports `cala`; on Go, sends `RUN
   cala` and renders the CW pass, CCW pass, and automatic
   re-verification pass as their `CALA:` lines stream in, ending in the
   literal `CALA:apply diffDrive.setConfigValue(ConfigField
   .RotationalSlip, ...)` snippet.

Both wizards discover their own availability via `FUNCS` and refuse to
start — with a clear, non-alarming "this robot doesn't support
calibration yet" message, rather than a timeout — if `calx`/`cala`
isn't in the registry; this is independent of the ID-verb classification
work below; a wizard's availability is decided by `FUNCS`, not by
whether the endpoint classified as `calibration`, so a robot's own
declared function registry stays the single source of truth for "can I
run this" (see Design Rationale). Both use the sequenced, acked `RUN`
verb, so a wrong/missing program name surfaces as `err 1` rather than
silence, and a genuinely unresponsive robot is distinguishable from
that. The MakeCode snippet is never separately generated from parsed
constants — it is always the firmware's own last `...:apply ...` line,
rendered verbatim.

## Success Criteria

- A student can run the distance wizard (`RUN calx`) against a real,
  calibration-flashed robot and end with a copy-paste MakeCode snippet
  — the firmware's own `CALX:apply diffDrive.setWheelCalibration(...)`
  line — reflecting a plausible, real-world calibrated distance
  constant.
- A student can run the rotation wizard (`RUN cala`) against a real
  robot and end with the firmware's own `CALA:apply
  diffDrive.setConfigValue(ConfigField.RotationalSlip, ...)` line as the
  snippet, having watched both the CW/CCW measurement passes and the
  firmware's own automatic re-verification pass stream into view.
- Each wizard fails clearly (never fabricates or half-renders a
  snippet) when: `calx`/`cala` isn't in `FUNCS`'s registry; the `RUN`
  call itself errors (`err 1`); or the firmware's own `CALX:fail
  .../CALA:fail ...` line reports a failed run (missed line, missed
  arm, stalled drive) — each of these three is a visibly distinct
  state, not one generic "failed" message.
- Neither wizard requires, or renders, a nudge control or any
  beam-pointer affordance — both are corrected out of this sprint's
  design per the Detail-planning findings above.

## Scope

### In Scope

- Classifying a robot as `calibration` vs plain `robot` from the `ID`
  verb's `program` field (the second linked issue), and showing that
  classification on the front-page card and the device page.
- Distance-calibration wizard panel: setup instructions, `FUNCS`-gated
  `RUN calx`, live `CALX:` progress, distinct failure states, and the
  firmware's own final `CALX:apply ...` line as the snippet.
- Rotation-calibration wizard panel: setup instructions, `FUNCS`-gated
  `RUN cala`, live `CALA:` progress across both measurement passes and
  the firmware's own re-verification pass, and the final `CALA:apply
  ...` line as the snippet.
- `FUNCS`-based availability discovery for both wizards, independent of
  the `calibration`/`robot` classification above (discover, don't
  feature-detect by trial, and don't couple wizard availability to
  classification — see Design Rationale).
- Snippet display for both wizards — **this is the actual deliverable
  handed to the student**, rendered verbatim from the firmware's own
  report line, not generated by the console from parsed constants.
- Correcting UC-006/UC-007's stale "depends on the cleartext `RUN:`
  path" error-flow language and their beam-pointer/nudge-control
  description (both wrong per the Detail-planning findings above) —
  done as a ticket against `docs/design/usecases.md`, since that file
  is outside sprint-planner's own write scope.

### Out of Scope

- **Flashing the calibration firmware from the console.** The
  calibration hex (`nezha-robot-template`) now exists and is fetched
  through the existing release-flash path unchanged — no *new* flashing
  work is in scope. Confirming that path handles this specific release
  is a hardware-deferred check in this sprint's bench-verification
  ticket, not new flashing logic.
- Any new wire verb, `SET`/`GET` call the console itself issues, or
  protocol change — per the Detail-planning findings, both wizards only
  *consume* `FUNCS`/`RUN` and the existing per-endpoint rx log; the
  calibrated constants reach the student exclusively via the firmware's
  own emitted snippet lines.
- Nudge controls and any beam-pointer affordance — corrected out of
  scope; see Detail-planning findings.
- Provisioning, discovery, or any transport work — those belong to
  sprints 7/9/10 and are assumed already in place.
- A settable-role firmware change (specification.md §9 Q3(b)) — the
  `ID`-verb classification below supersedes the need for it, per the
  second linked issue.

## Stakeholder confirmations — resolved during detail-planning (2026-09-10)

Both items below blocked detail-planning under the roadmap entry. Both
are now resolved by verified evidence (see Detail-planning findings
above), not by this sprint closing them unilaterally:

1. ~~Confirm `d4d8e4e` is the intended upstream direction~~ — **resolved:
   confirmed permanent.** Five shipped sprints (003, 006-010) already
   depend on the sequenced, `FUNCS`-discoverable `RUN` this sprint's
   premise rests on.
2. ~~specification.md §9 Q1's status~~ — **resolved: a calibration hex
   exists.** `nezha-robot-template` is real, released, and fetched
   through the console's existing release path. This sprint plans
   against `calx`/`cala` specifically (verified live via `FUNCS`
   against that image), not against the old roadmap's guess at
   calibration-suitable names in the *student* build's registry
   (`cal`, `fix`, `arm`, etc. — a different vocabulary on a different
   firmware).

## Test Strategy

Split into test-provable and hardware-deferred; never check off a
criterion that wasn't exercised.

**Test-provable (against a fake link / fixture logs, no hardware):**
- `ID`-verb classification: a `program` matching `calibration-*`
  classifies `calibration`; anything else (including no `ID` reply at
  all) stays `robot`; the raw `program`/`version` strings are preserved
  verbatim for display.
- Both wizard panels' `FUNCS`-gating: enabled only when `calx`/`cala`
  (respectively) is present in `device.functions`; a bare `GET`-style
  one-shot `FUNCS` probe fires on mount/reopen, mirroring
  `CommandStrip`'s existing pattern.
- Both wizards' log-line parsing against fixture rx logs: a `CALX:`/
  `CALA:` progress line updates the visible state; the terminal
  `...:apply ...` line is extracted and rendered verbatim as the
  snippet; a `...:fail ...` line renders a distinct failure state
  (never a generic one); no snippet is ever rendered from anything
  other than an observed `...:apply ...` line.
- `RUN calx`/`RUN cala` dispatch through `sendCommand` exactly as
  `FunctionsPanel`'s Go button already does; an `err 1` reply is
  surfaced distinctly from "no `FUNCS` entry" and from a mid-run
  `CALX:fail`/`CALA:fail` line.
- `DevicePage`'s additive `calibration` dispatch case rendering
  `RobotPage` unchanged from the `robot` case, with the wizard panels
  present.

**Needs hardware (cannot be simulated meaningfully):** an actual
calibration-flashed robot laid out against two lines 90 cm apart
(`calx`) or a black-tape cross (`cala`); every real calibration run,
both wizards, end to end, including the firmware's own re-verification
pass for `cala`.

## Dependencies

Depends on sprint 6 (robot page, `sendCommand`/session machinery the
wizards reuse unchanged) and, transitively, on the `FunctionsPanel`/
`CommandStrip` patterns shipped out-of-process on top of sprints 009 and
012 (FUNCS discovery, RUN dispatch, per-endpoint rx-log harvesting —
this sprint adds no new host-side plumbing for the wizards themselves,
only the `ID`-verb classification work). Independent of sprint 9's own
WiFi-transport build; per the bench-verification ticket below, WiFi
*is* the actual bench transport this sprint verifies against (gopiv/
tigez, live today) — this supersedes the roadmap's blanket "default to
USB/radio" note, which predates today's live-hardware check. The
WiFi-`FUNCS`-truncation bug still applies to a *multi-line* `FUNCS`
listing, so a `calx`/`cala` FUNCS-gate check performed over WiFi should
be treated as unconfirmed until cross-checked over USB/radio at least
once; `RUN`/its `CALX:`/`CALA:` report lines are ordinary sequential rx
lines, not a multi-line reply, and are not known to be affected.

## Architecture

**Substantial** — three-plus modules touched across two packages
(`packages/protocol/src/deviceType.ts`, `packages/host/src/deviceRegistry.ts`,
and four `packages/ui` files: `pages/DevicePage.tsx`, `pages/FrontPage.tsx`,
`pages/RobotPage.tsx`, plus two new wizard-panel components), and this
sprint introduces a genuinely new cross-module concern: a fourth
`DeviceType` member threaded from the wire's `ID` reply through
classification, the wire contract, and two independent UI dispatch
points (front-page card, per-device-page routing). That is a
structural/type-model change in the same sense sprint 004's original
three-type union was, even though nothing is *persisted* — matching
this project's own bar for "substantial" (module count plus a new
cross-cutting type, not lines of code). No ERD: nothing this sprint
adds is persisted (classification stays in-memory per endpoint, exactly
like `role`/`commonName` do today).

### Step 1 — Understand the problem

Two independent problems, previously bundled as one blocked-on-firmware
item:

1. **A calibration robot and a student robot are indistinguishable
   today.** Both emit the identical `device NEZHA2 robot <name>
   <serial>` banner shape; only the separately-issued `ID` verb's
   `program` field differs (`calibration-<version>` vs a build's own
   name, e.g. `tovez`). No firmware change is needed to fix this — the
   signal already exists on the wire and simply isn't read.
2. **Turning `calx`/`cala` into a guided, no-manual-arithmetic
   experience.** Per the Detail-planning findings, both routines are
   already autonomous and self-reporting; the console's job is
   presentation and sequencing (setup instructions → gate on `FUNCS` →
   `RUN` → watch the log → show the snippet), not measurement or
   correction logic of its own.

These two problems are independent of each other (see Design
Rationale, "Wizard availability is `FUNCS`-gated, not
classification-gated") and are addressed by separate module groups
below.

### Step 2 — Responsibilities

1. **Classifying a robot as `calibration` vs `robot` from its `ID`
   reply** — changes only when the wire's `ID` grammar or the
   `calibration-` prefix convention changes.
2. **Surfacing that classification** (front-page card badge, device
   page routing/diagnostics) — changes only when what the UI shows or
   which page it routes to changes, independent of how classification
   itself is derived.
3. **Running one calibration routine and narrating its progress** (the
   distance wizard) — changes only when `calx`'s own report-line
   grammar or the distance-wizard's own UX changes.
4. **Running the other calibration routine and narrating its progress**
   (the rotation wizard) — changes only when `cala`'s own report-line
   grammar or the rotation-wizard's own UX changes. Kept a separate
   responsibility from 3 despite the obvious symmetry, because the two
   routines' report grammars, setup instructions, and pass structure
   (single pass vs CW/CCW/re-verify) genuinely differ — see Step 3's
   shared-parser module for what *is* common between them.
5. **Correcting the stale, pre-firmware use-case text** (UC-006/
   UC-007's error flows and physical-setup description) — a
   documentation responsibility, changes only when this sprint's own
   findings need to be reflected upstream, and is out of sprint-planner's
   write scope (see Design Rationale).

### Step 3 — Subsystems and modules

| Module | Purpose (one sentence, no "and") | Boundary | Serves |
|---|---|---|---|
| `packages/protocol/src/deviceType.ts` (extended) | Classify a device from its banner and, now, its `ID` reply's `program` field | Pure function, no I/O; `DeviceType` gains `"calibration"`; `normalizeDeviceType` still coerces anything unrecognized to `"unknown"`, so an older client degrades safely | SUC-001 |
| `packages/host/src/deviceRegistry.ts` (extended) | After a successful robot identify, send unsequenced `ID` and refine `classification` from its reply, transport-blindly (one shared connect path already serves USB/relay/mbserial/WiFi) | No UI knowledge; writes `EndpointListEntry.classification`, exactly as it already writes `role`/`commonName` from the banner | SUC-001 |
| `packages/ui/src/pages/FrontPage.tsx` (extended) | Render a `calibration`-classified card with a distinct label from a plain `robot` card | Consumes `WsProvider` selectors only, same discipline every other card follows | SUC-002 |
| `packages/ui/src/pages/DevicePage.tsx` (extended) | Route a `calibration`-classified endpoint to `RobotPage`, additively | One new `switch`/dispatch arm; no change to the existing `robot`/`relay`/`unknown` arms | SUC-002 |
| `packages/ui/src/pages/RobotPage.tsx` (extended) | Mount the two wizard panels alongside the page's existing panels, and show the raw `program`/`version` diagnostics | No transport awareness (unchanged discipline `RobotPage.transportBlind.test.ts` enforces); no device-type branch beyond mounting the two new panels unconditionally, same as every other panel | SUC-002, 003, 004 |
| `packages/ui/src/components/CalibrationReport.ts` (new, pure) | Parse a `CALX:`/`CALA:`-prefixed rx-log line into a typed progress/failure/snippet event | No I/O, no React, no knowledge of `RUN`/`FUNCS`/`sendCommand` — a pure string-in, typed-event-out module, mirroring `FunctionsPanel.parseSignature`'s own "pure parsing helper, no state" shape | SUC-003, 004 |
| `packages/ui/src/components/DistanceCalibrationWizard.tsx` (new) | Guide the distance-calibration flow (`calx`) end to end | Reads `device.functions`/`useEndpointLog`, calls `sendCommand`, renders via `CalibrationReport` — no reply-parsing logic of its own beyond that shared module | SUC-003 |
| `packages/ui/src/components/RotationCalibrationWizard.tsx` (new) | Guide the rotation-calibration flow (`cala`) end to end | Same boundary as the distance wizard; the CW/CCW/re-verify pass structure is this component's own state, not pushed into `CalibrationReport` | SUC-004 |
| `docs/design/usecases.md` (UC-006/UC-007, ticket-level edit) | Describe the wizards' actual current flow | Prose only; no code | SUC-003, 004 |

Every module addresses at least one SUC; no module has more than one
reason to change; dependency direction is unchanged from every prior
sprint (`ui` → `WsProvider`/host types → `protocol`, no outward
dependency from `protocol`) — `CalibrationReport.ts` is a new leaf next
to `parseSignature`, with no outward dependency of its own. No cycle:
`deviceType.ts`'s classification has no dependency on the UI at all, and
the two wizard panels depend on `CalibrationReport.ts`, never the
reverse.

### Step 4 — Diagrams

Component diagram (required — a new cross-module dependency threads
`ID`-verb classification from `deviceType.ts` through `deviceRegistry.ts`
into two independent UI dispatch points, and both wizard panels
introduce a new shared leaf module):

```mermaid
flowchart LR
  subgraph Firmware
    ROBOT["calibration-flashed robot\n(id reply, calx/cala RUN, CALX:/CALA: report lines)"]
  end
  subgraph Protocol["packages/protocol"]
    DT["deviceType.ts\n(DeviceType += \"calibration\")"]
  end
  subgraph Host["packages/host"]
    DR["deviceRegistry.ts\n(sends ID after identify,\nrefines classification)"]
  end
  subgraph UI["packages/ui"]
    FP["FrontPage / EndpointCard\n(calibration badge)"]
    DP["DevicePage\n(+ \"calibration\" -> RobotPage)"]
    RP["RobotPage\n(mounts both wizards)"]
    CR["CalibrationReport.ts\n(pure CALX:/CALA: line parser)"]
    DW["DistanceCalibrationWizard.tsx"]
    RW["RotationCalibrationWizard.tsx"]
    WSP["WsProvider\n(sendCommand, useEndpointLog,\nunchanged)"]
  end

  ROBOT -- "id diffdrive calibration-<v> ..." --> DR
  DR -- "classify(banner, idReply)" --> DT
  DR -- "classification" --> WSP
  WSP -- "classification" --> FP
  WSP -- "classification" --> DP
  DP -- "endpoint" --> RP
  RP --> DW
  RP --> RW
  DW -- "sendCommand(RUN calx)" --> WSP
  RW -- "sendCommand(RUN cala)" --> WSP
  WSP -- "useEndpointLog (CALX:/CALA: lines)" --> DW
  WSP -- "useEndpointLog (CALX:/CALA: lines)" --> RW
  DW -- "parse(line)" --> CR
  RW -- "parse(line)" --> CR
  ROBOT -- "CALX:/CALA: report lines" --> WSP
```

No ERD (nothing persisted). No separate dependency-direction diagram —
the component diagram above already shows every new edge, and none of
them reverses the existing `ui → WsProvider → host-types → protocol`
direction.

### Step 5 — What changed / Why / Impact / Migration concerns

**What changed:**
- `deviceType.ts`: `DeviceType` gains `"calibration"`; `DeviceClassification`
  gains `program`/`version` (both `string | null`, preserved verbatim,
  `null` only when no `ID` reply was ever received); `normalizeDeviceType`
  unchanged in shape (still coerces anything unrecognized to `"unknown"`).
- `deviceRegistry.ts`: the one shared post-identify step (used by every
  transport) sends unsequenced `ID` after a `type: "robot"` classification
  and, on a reply matching `id <product> <program> <version> <name>`,
  refines `classification.type` to `"calibration"` when `program` matches
  `/^calibration-/`, else leaves it `"robot"`; a robot that never answers
  `ID` (older firmware, or the request timing out) stays `"robot"` — absence
  is never evidence of a student build, matching the linked issue's own
  design caution.
- `FrontPage.tsx`: `EndpointCard` renders a distinguishing label for
  `classification.type === "calibration"`.
- `DevicePage.tsx`: one additive dispatch arm, `case "calibration":
  return <RobotPage .../>` alongside the existing `"robot"` arm.
- `RobotPage.tsx`: mounts `DistanceCalibrationWizard` and
  `RotationCalibrationWizard` as two more panels (alongside
  `FunctionsPanel`/`ChartsPanel`/etc.), and shows the raw `program`/
  `version` strings for diagnostics, per the linked issue's Verification
  section.
- New `CalibrationReport.ts`, `DistanceCalibrationWizard.tsx`,
  `RotationCalibrationWizard.tsx`.
- `docs/design/usecases.md`: UC-006/UC-007 rewritten to drop the stale
  cleartext-`RUN:` dependency and the beam-pointer/nudge description.

**Why:** see Step 1 — classification closes the second linked issue
using a signal that already exists on the wire; the wizards are
presentation over already-autonomous, already-self-reporting firmware
routines, not new measurement logic.

**Impact on Existing Components:** additive everywhere.
`RobotPage.transportBlind.test.ts`'s existing scan needs its
`FILES_UNDER_TEST` list extended to the two new wizard components (the
same mechanical update every prior sprint that added a `RobotPage` panel
has made); no existing panel's behavior changes. `FunctionsPanel`/
`CommandStrip` are untouched — the wizards reuse their patterns
(`sendCommand`, `useEndpointLog`, one-shot `FUNCS`-on-open) without
modifying either.

**Migration Concerns:** None. No persisted data changes anywhere in
this sprint. `DeviceType` gaining a fourth member is additive to an
already-open union exactly as `wsMessages.ts`'s own doc comment already
documents for `classification.type` — an older UI build talking to a
newer host degrades an unrecognized type value to `"unknown"` via
`normalizeDeviceType`, landing on `UnknownDevicePage` (a benign, if
imprecise, fallback) rather than crashing. As with every prior sprint,
host and UI ship together, so this is a documented forward-compatibility
posture, not an active deployment concern.

### Design Rationale

**Decision: wizard availability is `FUNCS`-gated, not
classification-gated.**
- *Context:* a wizard could be shown only on `calibration`-classified
  endpoints, or shown on any `robot`/`calibration` endpoint and gated
  internally on whether `FUNCS` reports `calx`/`cala`.
- *Alternatives considered:* (a) gate on `FUNCS` only, independent of
  classification; (b) show the wizard panels only when
  `classification.type === "calibration"`.
- *Why (a):* the sprint's own Solution already commits to "discover,
  don't feature-detect" for `FUNCS`; making the wizard's visibility
  *also* depend on the separate `ID`-verb classification would couple
  two independently-changing signals (a firmware's declared function
  registry vs. its self-reported build profile) for no benefit, and
  would leave the wizard unusable for any future build that ships
  `calx`/`cala` under a non-`calibration-`-prefixed program name. The
  linked issue's own design caution — "treat an unrecognized program as
  *some* robot program, never as an error" — argues the same way: don't
  let classification become a second gate.
- *Consequences:* a `calibration`-classified robot whose `FUNCS` happens
  not to list `calx`/`cala` (e.g. a future calibration variant with
  different routine names) still shows the wizard panels, correctly
  disabled/unavailable, rather than hiding them entirely — matching how
  `FunctionsPanel` already handles "no functions reported" as a real,
  displayed state rather than an absence.

**Decision: one shared `CalibrationReport.ts` parser, not two
independent per-wizard parsers.**
- *Context:* `calx`'s and `cala`'s report lines share a shape (`<PREFIX>:
  <event> ...`, a terminal `<PREFIX>:apply <snippet>` line, a `<PREFIX>:
  fail <reason>` line) but differ in their specific event vocabulary and
  pass structure.
- *Alternatives considered:* (a) one small shared module recognizing the
  common shape (prefix, apply-line extraction, fail-line detection) and
  returning the event's raw remainder for the calling wizard to interpret
  further; (b) two independent parsers, one per wizard, with no shared
  code.
- *Why (a):* the terminal-snippet-line extraction and the "never
  fabricate a snippet from anything but an observed `apply` line" safety
  property (Success Criteria) is exactly the kind of logic that must not
  silently drift between two copies; a shared module makes "the snippet
  always comes from a real firmware line" a single, testable invariant.
- *Consequences:* `CalibrationReport.ts` deliberately stays thin — it
  does not attempt to parse `calx`'s or `cala`'s measurement numbers out
  of their event lines (e.g. `CALX:measured=...`), since those are
  display-only and each wizard's own presentation differs; over-generalizing
  the parser to extract every field would recreate the "speculative
  generality" anti-pattern for fields nothing yet needs structured.

**Decision: the calibration-vs-student classification ships
independently of the wizard panels, not as one combined ticket.**
- *Context:* both are part of this sprint and touch `RobotPage`, but
  address genuinely different problems (see Step 1).
- *Why:* classification has host + protocol surface and no UI-visible
  wizard dependency; the wizards have zero dependency on classification
  (previous decision). Splitting lets classification's acceptance
  criteria (ID-reply parsing, the `calibration-` prefix match, the
  "absence is not evidence" rule) be reviewed and tested on their own,
  the same reasoning sprint 006 used to split e-stop into its own
  ticket.
- *Consequences:* one ticket sequenced first with no functional
  dependency from the wizard tickets, at the cost of the wizard tickets
  depending on it only for *routing* (a `calibration`-classified endpoint
  must reach `RobotPage` via ticket 002's dispatch arm before its wizards
  are reachable at all).

### Open Questions

1. Whether a `calibration`-classified robot should still be reachable
   by a student who wants to *drive* it normally (i.e., does
   `RobotPage`'s full panel set — drive controls, charts, etc. — make
   sense on a calibration image, or should some panels be
   calibration-specific?). This sprint mounts the full existing
   `RobotPage` unchanged plus the two wizards, on the reasoning that a
   calibration image still answers `WHEELS_V`/`STATUS`/etc. normally
   (confirmed live by this session's own `FUNCS` capture showing the
   full ordinary function registry) — flagged for stakeholder
   confirmation rather than assumed permanently correct.
2. Whether `specification.md` itself (not just `usecases.md`) should be
   corrected to record that a calibration hex now exists and `ID`
   carries the classification signal — a documentation-ticket judgment
   call for whoever executes ticket 005, not an architectural one.

## Use Cases

Substantial tier — full use cases. SUC-001 extends **UC-001 — Connect
and identify a device over USB** (and, transport-blindly, UC-004/UC-010's
identify paths) with the second signal the linked issue adds. SUC-002 is
a new, small use case for the classification's UI surface (no existing
UC covers "show what kind of robot this is"). SUC-003/SUC-004 extend
**UC-006**/**UC-007** respectively, which this sprint's tickets also
correct in `docs/design/usecases.md` to match the findings above.

### SUC-001: Classify a robot as calibration or student from its ID reply
Parent: UC-001 (Connect and identify a device over USB)

- **Actor**: robot-console host (`deviceRegistry.ts`), automatic.
- **Preconditions**: A device has just classified as `type: "robot"`
  from its boot banner (any transport).
- **Main Flow**:
  1. The host sends unsequenced `ID`.
  2. The reply `id <product> <program> <version> <name>` is parsed;
     `program` matching `/^calibration-/` refines `classification.type`
     to `"calibration"`; anything else leaves it `"robot"`.
  3. The raw `program`/`version` strings are preserved verbatim on
     `classification` for display.
- **Postconditions**: `EndpointListEntry.classification` distinguishes a
  calibration robot from a student robot; a robot that never answers
  `ID` (no reply, or older firmware without the verb) stays `"robot"`,
  never `"unknown"` and never `"calibration"`.
- **Acceptance Criteria**:
  - [ ] A fixture `ID` reply with `program: "calibration-0.20260907.2"`
        classifies `"calibration"`.
  - [ ] A fixture `ID` reply with `program: "tovez"` (or any non-
        `calibration-`-prefixed value) classifies `"robot"`.
  - [ ] No `ID` reply within the request's timeout leaves classification
        at `"robot"` (the value `classifyBanner` already produced from
        the banner) — never `"unknown"`, never `"calibration"`.
  - [ ] The match is on the `calibration-` *prefix*, not an exact
        version string — a fixture with a different trailing version
        still classifies `"calibration"`.
  - [ ] `classification.program`/`.version` are preserved verbatim on
        both outcomes above.

### SUC-002: See a robot's calibration/student classification in the UI
Parent: UC-001

- **Actor**: Student.
- **Preconditions**: A robot endpoint has classified per SUC-001.
- **Main Flow**:
  1. The front-page card for a `calibration`-classified endpoint shows
     a distinguishing label from a plain `robot` card.
  2. Navigating to the endpoint's own page renders `RobotPage`
     regardless of which of the two robot classifications it carries
     (the additive `DevicePage` dispatch arm).
  3. `RobotPage` shows the raw `program`/`version` strings somewhere
     visible, for diagnostics.
- **Postconditions**: A student (or instructor) can tell, without
  reading the console log, whether a connected robot is running the
  calibration image or a student build.
- **Acceptance Criteria**:
  - [ ] `FrontPage` renders a `calibration`-distinguishing label for a
        `classification.type === "calibration"` fixture.
  - [ ] `DevicePage`'s dispatch renders `RobotPage` for both `"robot"`
        and `"calibration"` fixtures, with no change to the existing
        `"relay"`/`"unknown"` arms.
  - [ ] `RobotPage` displays the raw `program`/`version` strings for a
        `calibration` fixture.

### SUC-003: Run the distance calibration wizard
Parent: UC-006 (Run a distance calibration)

- **Actor**: Student.
- **Preconditions**: `RobotPage` open for a robot endpoint; the student
  has laid two lines 90 cm apart per the panel's own setup instructions.
- **Main Flow**:
  1. The panel's own one-shot `FUNCS` probe (on mount/reopen) reports
     whether `calx` is registered; if not, the panel shows a clear,
     non-alarming "this robot doesn't support calibration yet" state and
     Go is disabled.
  2. Student presses Go; the panel sends `RUN calx` via `sendCommand`.
  3. As `CALX:` lines stream into the endpoint's rx log, the panel
     renders visible progress (line found, driving, etc.) via
     `CalibrationReport`.
  4. On a `CALX:apply ...` line, the panel renders that line verbatim as
     the copy-paste MakeCode snippet.
- **Postconditions**: The student has a real, firmware-computed distance
  constant ready to paste into their own program, or a clear failure
  state if the run did not produce one.
- **Acceptance Criteria**:
  - [ ] Go is disabled, with the "unavailable" message, when a fixture
        `FUNCS` response omits `calx`.
  - [ ] Pressing Go with `calx` available sends `RUN calx` via
        `sendCommand` (fake-link test, mirroring `FunctionsPanel`'s own
        `RUN` dispatch assertion).
  - [ ] A fixture log ending in a `CALX:apply
        diffDrive.setWheelCalibration(0.7912)` line renders that exact
        text as the snippet — never a value computed independently by
        the panel.
  - [ ] A fixture log ending in `CALX:fail no start line within 60cm` (or
        any `CALX:fail ...` line) renders a distinct failure state, no
        snippet.
  - [ ] A `RUN` `err 1` reply renders a distinct "wrong/missing program"
        state, not the same as a `CALX:fail` state or a timeout.
  - [ ] **Hardware-deferred:** a real run against a calibration-flashed
        robot on a physical 90 cm track produces a plausible constant —
        deferred to the bench-verification ticket.

### SUC-004: Run the rotation calibration wizard
Parent: UC-007 (Run a rotation calibration)

- **Actor**: Student.
- **Preconditions**: `RobotPage` open for a robot endpoint; the student
  has placed the robot on a black-tape cross per the panel's own setup
  instructions (no beam pointer).
- **Main Flow**:
  1. The panel's own one-shot `FUNCS` probe reports whether `cala` is
     registered; same unavailable state as SUC-003 if not.
  2. Student presses Go; the panel sends `RUN cala`.
  3. As `CALA:` lines stream in, the panel renders the CW pass, the CCW
     pass, and the firmware's own automatic re-verification pass as
     distinct, visible stages via `CalibrationReport`.
  4. On the `CALA:apply ...` line, the panel renders it verbatim as the
     snippet.
- **Postconditions**: The student has a real, firmware-computed,
  self-verified wheelbase (`RotationalSlip`) constant ready to paste, or
  a clear failure state.
- **Acceptance Criteria**:
  - [ ] Go is disabled, with the "unavailable" message, when a fixture
        `FUNCS` response omits `cala`.
  - [ ] Pressing Go with `cala` available sends `RUN cala`.
  - [ ] A fixture log carrying both CW/CCW measurement passes and a
        re-verification pass renders each as a distinct, visible stage
        (not collapsed into one "running" spinner).
  - [ ] A fixture log ending in `CALA:apply
        diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.958)`
        renders that exact text as the snippet.
  - [ ] A fixture log ending in any `CALA:fail ...` line (e.g. "missed
        an arm, re-centre the robot") renders a distinct failure state,
        no snippet.
  - [ ] No nudge control, and no beam-pointer-related UI, is rendered
        anywhere in this panel.
  - [ ] **Hardware-deferred:** a real run against a calibration-flashed
        robot on a physical black-tape cross produces a plausible,
        self-verified constant — deferred to the bench-verification
        ticket.

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [x] Both stakeholder confirmations above are answered (§9 Q3(a)/(d)
      direction; §9 Q1 calibration-hex status) — resolved 2026-09-10,
      see Detail-planning findings above.
- [x] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|
| 001 | Classify calibration vs student robots from the ID verb | — |
| 002 | Surface calibration classification on the front-page card and device page | 001 |
| 003 | Distance calibration wizard panel (shared report parser + calx flow) | 002 |
| 004 | Rotation calibration wizard panel (cala flow) | 002, 003 |
| 005 | Correct UC-006/UC-007 in `docs/design/usecases.md` to match the shipped calx/cala firmware | 003, 004 |
| 006 | Bench verification: both wizards against a calibration-flashed robot over WiFi | 003, 004 |

Tickets execute serially in the order listed.
