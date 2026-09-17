---
id: '013'
title: 'Configuration tab: flash calibration firmware with post-flash verification,
  run calx/cala, serial log under the code'
status: done
use-cases: []
depends-on:
- '010'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Configuration tab: flash calibration firmware with post-flash verification, run calx/cala, serial log under the code

## Description

Stakeholder directive (2026-09-13), verbatim intent: "We still need a
way to flash calibration software. Put this as a flash button under the
calibration section in the Configuration tab. Once you flash, check to
see that we've got the calibration firmware. We need to be able to run
the two calibration programs from the configuration menu. I also want
the right side underneath your code to show the log coming from the
serial, coming from the robot."

Commit `f1b0e8d` (earlier today) put a calibration-firmware panel,
`cal*` run buttons, and a filtered calibration console on the
**Calibration** tab, mis-labelled as ticket 010 work — 010 was UI
truthfulness (link-status text), not this feature. This ticket owns the
work described above and relocates the flash/verify/run pieces to the
**Configuration** tab, per the stakeholder's explicit placement.

Established facts (do not re-derive):
- The calibration program IS the configured `robot` firmware release —
  a flashed calibration robot identifies as
  `id diffdrive calibration-0.20260913.1 …`.
  `ROBOT_CONSOLE_ROBOT_FIRMWARE` = `nezha-robot-template:latest` =
  `v0.20260913.1`. Flashing "calibration firmware" is flashing this
  same `robot` release — there is no separate firmware artifact to
  select.
- `isCalibrationProgram` in `packages/ui/src/deviceDisplay.ts` already
  recognizes a calibration build from the reported program string — use
  it rather than re-deriving the check.
- The two calibration functions are `RUN calx` (distance/wheel diameter,
  emits `CALX:` lines) and `RUN cala` (rotation, emits `CALA:` lines).
  Both are already run and their output parsed by
  `DistanceCalibrationWizard.tsx` / `RotationCalibrationWizard.tsx` into
  `lib/calibration.ts`'s `CalibrationState` — reuse that parsing, do not
  duplicate it.
- Flashing already flows through `flash-start` plus the existing
  `useFlashProgress` hook/phase plumbing (see the Calibration-tab panel
  added in `f1b0e8d` for the pattern to move, not re-invent).

## Acceptance Criteria (corrected 2026-09-13 — see Correction Notes below)

The stakeholder's own same-day correction moves every flash/run control
back onto the **Calibration** tab: "If we have a Calibrate tab, then we
don't need calibration under the Configuration tab. You can just put it
under Calibrate. Also, we still need flash." The criteria below
supersede the original list (kept, struck through in spirit, by the
Correction Notes section) and reflect the corrected placement.

- [x] A new `CalibrationFirmwarePanel.tsx` component (`{ device, link }`)
      holds the "Calibration firmware" block — current program/version,
      whether it is the calibration build (`isCalibrationProgram`), and
      a **Flash calibration firmware** button that sends
      `flash-start {kind:"release", firmware:"robot"}` for the robot's
      flashable link (the routed link if it can itself be flashed, else
      the device's other flashable link). With no flashable link, it
      says "Plug the robot in over USB, or put it on a farm host, to
      flash." — worded for both USB and the concurrent 018-014 farm-host
      flash path, no button shown as if it might work. Flash phases
      surface inline via the existing `useFlashProgress` plumbing.
- [x] After a flash completes, the panel reports — from the fresh
      post-flash device snapshot, never assumed — whether `device.program`
      is now a calibration build ("Calibration firmware `<version>`
      confirmed") or not (shows the program actually reported, or the
      flash error if the flash itself failed).
- [x] `CalibrationPage.tsx` mounts `CalibrationFirmwarePanel` at the top
      of its left column (`RobotPage.tsx` passes `device` through to it
      again), followed by the existing "Calibrate X (distance)" and
      "Calibrate A (rotation)" wizards.
- [x] **`FUNCS` must never hide or block a calibration run**: both
      wizards always render and are never disabled on an absent `FUNCS`
      entry — root cause fixed this pass: a Wi-Fi burst can drop a line
      from the middle of `FUNCS`'s own reply (ack included) while the
      firmware genuinely has the function registered, so absence proves
      nothing. A known-missing name now only shows a non-blocking hint
      ("The robot's function list didn't include `<name>` (lines can
      drop over Wi-Fi) — you can still try; the robot will say err if
      it's missing.") on both `DistanceCalibrationWizard.tsx` and
      `RotationCalibrationWizard.tsx`; the "Not connected" hint and the
      rotation wizard's own wheel-diameter gate are unchanged.
- [x] `CalibrationPage.tsx`'s prior `FUNCS`-derived
      show/hide-the-wizard gating (`showDistanceWizard`/
      `showRotationWizard`/`noCalFunctions`/the "Checking which
      calibration functions…" hint) is removed outright — the two
      wizards are unconditional; any *other* `cal*` name `FUNCS` lists
      still gets its own `GenericCalibrationRun` control, unchanged.
- [x] The filtered `CalibrationConsole` panel is retired outright
      (`CalibrationConsole.tsx`/`.css`/its test deleted) — the right
      column's full, unfiltered `DeviceConsole` is the only console on
      this tab now, same as it always was in the right column.
- [x] `ConfigurationPage.tsx` no longer renders a "Calibration firmware"
      block or calx/cala run buttons, and no longer requests `FUNCS` —
      it keeps only the Calibration values table, Wi-Fi, Radio, the
      footer actions, the generated code, and (unchanged from this
      ticket's original pass) the unfiltered `DeviceConsole` under the
      code, for which it still takes `link`.
- [x] Results from running `calx`/`cala` still flow through the existing
      wizard parsers (`DistanceCalibrationWizard.tsx` /
      `RotationCalibrationWizard.tsx` → `lib/calibration.ts`) into the
      same `CalibrationState` `CalibrationTable.tsx` displays on both
      tabs. No second/duplicate parser for `CALX:`/`CALA:` lines.
- [x] Unit tests for each behavior above, moved/added across
      `CalibrationFirmwarePanel.test.tsx` (new, standalone component
      coverage), `CalibrationPage.test.tsx` (mounted coverage of the
      relocated firmware panel, the always-render wizard behavior, and
      the retired `CalibrationConsole` describe block deleted),
      `ConfigurationPage.test.tsx` (firmware/run describe blocks
      removed), `DistanceCalibrationWizard.test.tsx`/
      `RotationCalibrationWizard.test.tsx` (the non-blocking-hint
      behavior), and `RobotPage.test.tsx` (the Calibration/Configuration
      tab expectations inverted).

## Completion Notes (2026-09-13)

Implemented as planned: `RobotPage.tsx` now passes `link` to
`ConfigurationPage` (and no longer passes `device` to `CalibrationPage`,
which lost its last use of that prop once the firmware panel moved).
`ConfigurationPage.tsx` gained the "Calibration firmware" block (direct
`flash-start`/`useFlashProgress`/`onFlashResult` wiring, deliberately
*not* `FlashDialog`/`FlashControls` -- those navigate to "/" on success
and offer a relay/robot/local-hex picker, wrong shape for a single
always-the-robot-release button that must stay on this page and report
its own outcome inline) and the "Run calibration" block (the existing
`DistanceCalibrationWizard`/`RotationCalibrationWizard` mounted
unchanged, under "Calibrate X (distance)"/"Calibrate A (rotation)"
headings, plus a shared "Not connected" hint for the no-session case
the wizards' own copy doesn't say). `DeviceConsole` mounted in the right
column under the code block. `CalibrationPage.tsx` had its firmware
panel, `canBeFlashed`/`isCalibrationProgram`/`FlashDialog` imports, and
now-unused `device` prop removed; its wizards/console/`FUNCS`-derived
run controls are untouched.

**Attribution correction**: `f1b0e8d`'s commit message and every doc
comment/test description it touched (`CalibrationPage.tsx`,
`CalibrationPage.test.tsx`, `CalibrationConsole.tsx`/`.test.tsx`,
`CalibrationTable.tsx`/`.test.tsx`, `RotationCalibrationWizard.tsx`/
`.test.tsx`, `lib/calibration.ts`/`.test.ts`, `RobotPage.tsx`/
`.test.tsx`) cited "ticket 018-010" for this feature -- 010 is UI
truthfulness (link-status text), unrelated. All of those citations are
now "018-013". `deviceDisplay.ts` and every other file whose own
"018-010" references are genuinely about the truthfulness ticket were
left untouched.

**Tests**: `npx vitest run packages/ui` -- 41 files, 656 passed (0
failed). `npm run typecheck`, `npm run vite:build -w @robot-console/ui`,
and `npm run build` all clean. New/updated cases: `ConfigurationPage.test.tsx`
(FUNCS-on-mount alongside the pre-existing Wi-Fi ask; the firmware block's
program/version text, USB-required hint, Flash click -> `flash-start`,
inline phase progress, confirmed/mismatched/error post-flash outcomes;
calx run -> `RUN calx` -> shared `CalibrationState`; both Go buttons
disabled with a "Not connected" reason when the link has no open
session; the unfiltered `DeviceConsole` under the code panel) plus the
`mountPage`/`robot` fixture threading `link`; `CalibrationPage.test.tsx`
(firmware-panel tests removed, `device` prop dropped from `mountPage`);
`RobotPage.test.tsx` (Calibration tab no longer shows the firmware panel;
Configuration tab does).

**Evidence**: a host on a throwaway copy of the stakeholder's own
`~/.local/state/robot-console/console.sqlite` (+`-wal`/`-shm`,
`ROBOT_CONSOLE_STATE_DIR` pointed at
`scratchpad/018-013-state/`, `--no-open --no-sweep`, port 18913),
verified via `lsof -p <pid>` before screenshotting that it held only the
copy's files, never the live ones. Headless Chrome (playwright-core,
system Chrome) opened `/d/mbserial-gopiv`, clicked the Configuration
tab, and screenshotted it (`scratchpad/configuration-tab.png`,
visually inspected): the Calibration panel is followed by "Calibration
firmware" (gopiv has no USB link in this snapshot, so it reads "Plug
the robot in over USB to flash.", no button) and "Run calibration"
("Not connected — open a link to this robot to run calibration.", both
wizards present but disabled), Wi-Fi and Radio panels below, and the
full serial-log `DeviceConsole` under "Code for your program" on the
right. No console/page errors. The host I started was killed
afterward; no other process was touched; no real robot was driven or
flashed.

## Correction Notes (2026-09-13)

Stakeholder feedback, verbatim: "If we have a Calibrate tab, then we
don't need calibration under the Configuration tab. You can just put it
under Calibrate. Also, we still need flash. I don't know how you got
CalX on Vevov, but it's supposed to have both CalX and CalA. Why does it
only have one?"

**Root cause of "only CalX" (established, not re-derived)**: vevov's
`FUNCS` reply over Wi-Fi listed `trace, counters, wire, mdnsrx, square,
circle, calx` and stopped — the firmware (`nezha-robot-template`,
`test/calibratea.ts:353`) does register `cala`, but the last burst line
was dropped in transit (the same known Wi-Fi burst-drop issue this
ticket's own doc comments already discuss for `CALX:apply`/`CALA:apply`)
while the ack still arrived, so the list looked complete, and
`CalibrationPage.tsx`'s own `showRotationWizard` gate hid the rotation
wizard because `cala` wasn't in that incomplete list. This pass fixes
the general case, not just this one robot: **`FUNCS` must never hide or
block a calibration run** anywhere in the UI.

**What moved**: `CalibrationFirmwarePanel.tsx` (new component, extracted
verbatim from `ConfigurationPage.tsx`'s block, testids renamed
`calibration-firmware-*`/`calibration-flash-*`) now mounts at the top of
`CalibrationPage.tsx`'s left column; `RobotPage.tsx` passes `device`
back to `CalibrationPage` for it. `ConfigurationPage.tsx` lost the
firmware block, the run buttons, and the FUNCS-on-mount request
entirely — it keeps only the Calibration values table, Wi-Fi, Radio, the
footer, the code block, and (unchanged) the unfiltered `DeviceConsole`
under the code, for which it still takes `link`.

**What changed in the wizards**: `DistanceCalibrationWizard.tsx`/
`RotationCalibrationWizard.tsx`'s `goDisabled` no longer includes a
FUNCS-derived `available` term at all — only link-openness/run-in-
flight (and, for rotation, the wheel-diameter `disabled` prop) can
disable Go now. A `FUNCS`-known-missing name renders a non-blocking
hint ("...lines can drop over Wi-Fi) — you can still try; the robot will
say err if it's missing.") instead of the old blocking "doesn't support
calibration yet" message. `CalibrationPage.tsx`'s own
`showDistanceWizard`/`showRotationWizard`/`noCalFunctions` gating (and
its "Checking which calibration functions…" hint) is deleted — both
wizards render unconditionally; `FUNCS` is still requested once on
mount only so any *other* `cal*` name still gets a `GenericCalibrationRun`.

**What was retired**: `CalibrationConsole.tsx`/`.css`/its test (the
filtered console below the code block) — the right column's existing
unfiltered `DeviceConsole` already shows every line, and a second
filtered view of the same log added confusion without adding
information.

**Coordination**: ticket 018-014 (concurrent, host-side) makes
`link.capabilities.flash` true for a farm-hosted robot too via the
mbflash TCP service; `CalibrationFirmwarePanel` needed no change for
that beyond wording its no-link hint for both paths ("Plug the robot in
over USB, or put it on a farm host, to flash.") — the button stays keyed
on `canBeFlashed`, never a hardcoded transport check. No
`packages/host/**` or `deviceDisplay.ts` files were touched.

**Tests**: `npx vitest run packages/ui` — 41 files, 655 passed (0
failed): new `CalibrationFirmwarePanel.test.tsx` (11 cases, standalone
component mount); `CalibrationPage.test.tsx` (firmware-panel cases
re-added with a `device` fixture, the FUNCS-derived gating tests
replaced with "both wizards still render" cases, the `CalibrationConsole`
describe block deleted); `ConfigurationPage.test.tsx` (firmware/run
describe blocks removed, the FUNCS-on-mount expectation dropped from the
Wi-Fi test); `DistanceCalibrationWizard.test.tsx`/
`RotationCalibrationWizard.test.tsx` (the "unavailable" case now asserts
the non-blocking hint text and an enabled button); `RobotPage.test.tsx`
(the two tab expectations inverted back). `npm run typecheck`,
`npm run vite:build -w @robot-console/ui`, and `npm run build` all clean.

**Evidence**: a fresh host on a throwaway copy of the stakeholder's own
`~/.local/state/robot-console/console.sqlite` (+`-wal`/`-shm`,
`ROBOT_CONSOLE_STATE_DIR` pointed at a scratchpad directory, built via
`node bin/robot-console.js --no-open --no-sweep`, port 18913), verified
via `lsof -p <pid>` before screenshotting that it held only the scratch
copy's files, never the live ones. Headless Chrome (playwright-core,
system Chrome) opened `/d/mbserial-gopiv`: the Calibration tab
(`calibration-tab-2.png`) shows "Calibration firmware" ("Program:
unknown", a Flash button since no snapshot has marked robot firmware
configured yet in this scratch run), "Calibrate X (distance)" and
"Calibrate A (rotation)" both present with "Not connected" hints (no
open session in this snapshot), the code block, and the full
`DeviceConsole`; the Configuration tab (`configuration-tab-2.png`) shows
only the Calibration values table, Wi-Fi, Radio, the footer, the code,
and the same `DeviceConsole` — no firmware block, no run buttons. No
console/page errors on either tab. The host I started was stopped
afterward via its own background-task id; no other process was touched;
no real robot was driven or flashed.

## Testing

- **Existing tests to run**: `packages/ui/src/pages/ConfigurationPage.test.tsx`,
  `packages/ui/src/pages/RobotPage.test.tsx`,
  `packages/ui/src/pages/CalibrationPage.test.tsx` (or equivalents),
  plus the full `packages/ui` scoped run.
- **New tests to write**: flash-and-verify cycle for the Configuration
  tab's calibration-firmware block (flash success → calibration
  confirmed; flash success → non-calibration program reported; flash
  error path); calx/cala button gating (no session, no FUNCS entry,
  both present) and dispatch (`RUN calx`, `RUN cala`) with results
  landing in the shared `CalibrationState`; right-column
  `DeviceConsole` presence and that it is unfiltered; Calibration tab
  test confirming the firmware/flash panel no longer renders there.
- **Verification command**: `npx vitest run packages/ui`; also
  `npm run typecheck`, `npm run vite:build -w @robot-console/ui`,
  `npm run build`, and a headless-Chrome screenshot of the Configuration
  tab on gopiv's page from a host started on a scratch copy of the
  state DB (no real robot driven, nothing actually flashed during this
  evidence pass).

## Implementation Plan

**Approach**: move the calibration-firmware panel, flash button, and
verification logic added in `f1b0e8d` from the Calibration tab to the
Configuration tab (threading `link` through from `RobotPage.tsx`),
add the two `RUN calx`/`RUN cala` buttons wired to the existing wizard
parsers/`CalibrationState`, and mount the existing unfiltered
`DeviceConsole` in the Configuration tab's right column under "Code for
your program." Prefer relocating and re-wiring existing code over
writing new parsing or flash logic — the flash plumbing, the
`isCalibrationProgram` check, and the `calx`/`cala` result parsers all
already exist elsewhere in the tree.

**Files to modify**:
- `packages/ui/src/pages/RobotPage.tsx` — pass `link` through to
  `ConfigurationPage`.
- `packages/ui/src/pages/ConfigurationPage.tsx` — accept `link`; add the
  "Calibration firmware" flash/verify block; add the calx/cala run
  buttons; mount `DeviceConsole` under "Code for your program."
- `packages/ui/src/pages/CalibrationPage.tsx` (or wherever `f1b0e8d`
  added the firmware panel) — remove the duplicated firmware/flash
  panel; keep the distance/rotation wizards intact.
- `packages/ui/src/lib/calibration.ts` — reuse `CalibrationState`
  as-is; extend only if the Configuration-tab buttons need a shared
  entry point the wizards don't already expose.
- Associated `*.test.tsx` files for each page above.

**Testing plan**: scoped `npx vitest run packages/ui` after each
component change; full evidence run (`vitest`, `typecheck`,
`vite:build -w @robot-console/ui`, `build`) plus a manual headless-
Chrome screenshot of the Configuration tab against a scratch copy of
the state DB before marking this ticket done.

**Documentation updates**: none anticipated beyond this ticket's own
completion notes; note in the ticket's completion notes that `f1b0e8d`'s
placement was corrected.
