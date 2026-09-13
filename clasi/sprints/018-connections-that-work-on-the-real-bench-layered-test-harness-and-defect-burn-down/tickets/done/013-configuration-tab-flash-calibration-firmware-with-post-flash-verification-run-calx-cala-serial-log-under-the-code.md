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

## Acceptance Criteria

- [x] `ConfigurationPage.tsx` receives the routed `link` (from
      `RobotPage.tsx`), in addition to `device`, so it can target the
      correct USB link for flashing.
- [x] Under the Configuration tab's "Calibration" panel: a "Calibration
      firmware" block shows the current program/version and whether it
      is the calibration build (via `isCalibrationProgram`), with a
      **Flash calibration firmware** button that sends
      `flash-start {kind:"release", firmware:"robot"}` for the robot's
      `usb` link (the routed link if it is USB, else the device's
      current USB link). With no current USB link, the block says
      plainly "Plug the robot in over USB to flash." — no button shown
      as if it might work. Flash phases surface inline via the existing
      `useFlashProgress` plumbing (the same phase states already wired
      for other flash buttons).
- [x] After a flash completes, the block reports — from the fresh
      post-flash device snapshot, never assumed — whether `device.program`
      is now a calibration build ("Calibration firmware `<version>`
      confirmed") or not (shows the program actually reported, or the
      flash error if the flash itself failed). No optimistic "flashed
      successfully" text that isn't backed by the post-flash snapshot.
- [x] Two buttons on the Configuration tab: "Calibrate X (distance)"
      (sends `RUN calx`) and "Calibrate A (rotation)" (sends
      `RUN cala`). Each is gated on (a) an open answering session for
      the device, and (b) `FUNCS` listing the corresponding function
      name — `FUNCS` is requested once on mount if not already known.
      A disabled button carries a plain-language reason (e.g. "Not
      connected", "Firmware doesn't support calx").
- [x] Results from running `calx`/`cala` flow through the existing
      wizard parsers (`DistanceCalibrationWizard.tsx` /
      `RotationCalibrationWizard.tsx` → `lib/calibration.ts`) into the
      same `CalibrationState` that the Configuration tab's
      "Calibration" table already displays (wheel diameter, wheel
      track, measured track width, effective track width, rotational
      slip). No second/duplicate parser for `CALX:`/`CALA:` lines.
- [x] Right column of the Configuration tab, under "Code for your
      program": mounts the full robot serial log via the existing
      `DeviceConsole` component — the same unfiltered console the Main
      tab mounts — not a filtered/calibration-only console.
- [x] The Calibration tab no longer duplicates the firmware-flash panel
      added in `f1b0e8d` — there is exactly one place in the UI to
      flash calibration firmware (the Configuration tab). The
      Calibration tab's distance/rotation wizards continue to work
      unchanged (they still run their own sessions independently of the
      Configuration-tab buttons above).
- [x] Unit tests for each behavior above: `ConfigurationPage` receiving
      and using `link`; the flash button send/verify cycle (mocked
      socket); the calx/cala buttons' gating (session + FUNCS) and
      dispatch; the right-column `DeviceConsole` mount; the Calibration
      tab no longer rendering a firmware/flash panel. Existing
      `ConfigurationPage`/`RobotPage`/`CalibrationPage` tests updated as
      needed for the moved panel and the new `link` prop.

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
