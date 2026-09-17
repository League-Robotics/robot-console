---
id: 018
title: 'Robot page console fits the screen: fixed-height log, send line pinned at
  the bottom'
status: done
use-cases: []
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Robot page console fits the screen: fixed-height log, send line pinned at the bottom

## Description

Stakeholder direction (2026-09-14, verbatim intent): "On the calibration
page, the console on the right side must always completely fit on the
screen. It keeps getting bigger and pushing the line down. Make it a
fixed size that fits the screen. The entry where you type and send a
command is always at the bottom of the screen."

The console component is `packages/ui/src/components/DeviceConsole.tsx`
/ `DeviceConsole.css`. It is mounted in the right column of three tabs:
the Main tab (`packages/ui/src/pages/RobotPage.tsx`, console +
`CommandStrip` below it), the Calibration tab
(`packages/ui/src/components/CalibrationPage.tsx`, console below a
"Current calibration" panel) and the Configuration tab
(`packages/ui/src/components/ConfigurationPage.tsx`, console below its
own left/right content).

`packages/ui/src/pages/RobotPage.css` already solves this correctly for
the Main tab only: the Main tab's right column gets the
`robot-page-column-console` class (`height: calc(100vh - 11rem);
min-height: 24rem`, see that file's own doc comment), which bounds the
column to the viewport so `DeviceConsole`'s `flex: 1; min-height: 0` log
(`.robot-page-column-right .device-console` /
`.robot-page-column-right .console-log` in the same file) fills the
remaining space and scrolls internally, with `CommandStrip` staying
pinned below it. The file says outright: "Only the Main tab's console
column takes the viewport height." `CalibrationPage.tsx` and
`ConfigurationPage.tsx` both render their console inside a plain
`robot-page-column-right` div with no `-console` modifier, so their
right column has no height bound at all — it grows to whatever its
content (the "Current calibration" panel plus `DeviceConsole`) needs.
`DeviceConsole.css`'s own `.console-log { max-height: calc(100vh -
22rem) }` bounds the log element itself, but that is a flat
approximation that does not know how tall the panel(s) above it in a
given column are, and — critically — it does not bound the *column*, so
once the column's natural height exceeds the viewport the whole page
scrolls, taking the send line with it. That is exactly the reported
symptom: the console area "keeps getting bigger" (more log lines, or a
taller panel above it) and "push[es] the line down" out of view.

Fix by extending the Main tab's already-correct pattern — a
viewport-bound column with the log as the flexible element and the send
line pinned at the bottom — to the Calibration and Configuration tabs'
right columns too, accounting for whatever fixed-height content (the
"Current calibration" panel, etc.) sits above the console in those
columns so the whole column, not just the log, stays within the
viewport.

## Acceptance Criteria

- [x] On the Calibration tab, the right column is a viewport-bound flex
      column: its bottom edge sits at the bottom of the browser window,
      the console's log area fills the remaining height and scrolls
      internally, and the send line (input + Send button) is always
      visible at the bottom of the window, regardless of how many log
      lines have arrived or how tall the left column is.
- [x] Adding hundreds of log lines never changes the page's height or
      moves the send line down; the page itself does not scroll because
      of console growth (only the log's own internal scrollbar moves).
- [x] The Main tab keeps its existing behaviour unchanged (it already
      does this correctly via `robot-page-column-console`) and the
      Configuration tab gets the same behaviour as Calibration — console
      log fills remaining viewport height, send line pinned at the
      bottom of the window.
- [x] At a short window height (e.g. 700px) the log area shrinks (down
      to roughly an 8rem floor) rather than pushing the send line off
      screen; the send line is still visible without scrolling the page.
- [x] No regression to `RelayPage`/`UnknownDevicePage` or any other page
      embedding `DeviceConsole` outside a `robot-page-column-right`
      column — those keep their existing normal-document-flow behaviour
      (per `RobotPage.css`'s own doc comment, the viewport-bound rules
      are scoped via descendant selectors and must stay scoped).
- [x] Unit/component tests assert the layout classes/structure that
      produce this behaviour (e.g. that Calibration's and
      Configuration's right columns carry a viewport-bound class
      equivalent to the Main tab's, and that `DeviceConsole`'s log/send
      elements have the expected flex classes) — not just a visual
      snapshot.
- [x] Evidence: a headless-Chrome (playwright-core, already a
      dependency) measurement script that opens the Calibration (and
      Configuration) tab at 1400×900 and again at 1400×700, injects 300
      synthetic log lines into the mounted link's log, and asserts the
      send input's bottom edge is `<=` the viewport height in both
      cases. `npx vitest run packages/ui`, `npm run typecheck`, and
      `npm run vite:build -w @robot-console/ui` all green.

## Implementation Plan

**Approach**: generalize the Main tab's existing, already-correct
viewport-bound column pattern (`RobotPage.css`'s
`.robot-page-column-console` + `.robot-page-column-right .device-console`
/ `.console-log` rules) to the Calibration and Configuration tabs'
right columns, rather than inventing a new mechanism. The Main tab's
`11rem` deduction is an approximation for "everything above this
column"; Calibration's and Configuration's right columns additionally
carry a "Current calibration" panel (or equivalent) above the console,
so their deduction needs to account for that panel's own height too —
either by giving the panel a natural/bounded height and letting the
console fill the rest via `flex: 1; min-height: 0` inside a
viewport-bound column (preferred, mirrors the Main tab exactly and
avoids a second magic constant), or by widening the column's own
`height: calc(100vh - Nrem)` deduction if the panel's height is
effectively fixed. Prefer a shared class (e.g. reuse
`robot-page-column-console` itself, or extract a common modifier) over
duplicating the Main tab's rules three times, so a future fourth tab
gets this for free.

Also revisit `DeviceConsole.css`'s own `.console-log { max-height:
calc(100vh - 22rem); min-height: 12rem }` — once the column itself is
viewport-bound and the log is `flex: 1; min-height: 0` inside it (as
the Main tab already does via `RobotPage.css`'s override), the
standalone `max-height` becomes redundant/conflicting for the
viewport-bound pages; keep whatever base rule non-column-bound pages
(`RelayPage`, `UnknownDevicePage`) still need, but make sure it does not
fight the override on the three robot-page tabs. Bring the `min-height`
floor down toward ~8rem per the acceptance criteria's short-window
requirement (currently 12rem on the base rule; check what the Main
tab's `min-height: 24rem` column floor actually leaves for the log at
700px and adjust whichever number is the actual constraint).

**Files to modify**:
- `packages/ui/src/pages/RobotPage.css` (generalize/extract the
  viewport-bound column rules so Calibration/Configuration can reuse
  them)
- `packages/ui/src/components/CalibrationPage.tsx` /
  `CalibrationPage.css` (apply the viewport-bound class to the right
  column; account for the "Current calibration" panel's height)
- `packages/ui/src/components/ConfigurationPage.tsx` /
  `ConfigurationPage.css` (same, for whatever sits above its console)
- `packages/ui/src/components/DeviceConsole.css` (adjust
  `.console-log`'s `max-height`/`min-height` so it composes correctly
  with the viewport-bound override instead of fighting it; lower the
  floor toward ~8rem if that is the binding constraint at 700px)

**Testing plan**:
- Component/unit tests (`CalibrationPage.test.tsx`,
  `ConfigurationPage.test.tsx`, `RobotPage.test.tsx`,
  `DeviceConsole.test.tsx` as applicable) asserting the right column and
  console elements carry the expected viewport-bound layout classes on
  all three tabs.
- A new headless-Chrome script (playwright-core) that renders the app
  (or a minimal harness page mounting `CalibrationPage`/
  `ConfigurationPage` with a fake link/log), sets the viewport to
  1400×900 then 1400×700, appends 300 synthetic log lines, and measures
  `console-send-input`'s bounding rect against `window.innerHeight` —
  this is the acceptance criterion's required evidence, not just a
  manual check. Place it under `scripts/` or `packages/ui` test infra
  matching this codebase's existing conventions (see `scripts/bench`
  for the existing playwright-core usage pattern), scoped so it does
  not require real bench hardware.
- Scoped run: `npx vitest run packages/ui`. Full green:
  `npm run typecheck`, `npm run vite:build -w @robot-console/ui`.

**Documentation updates**: none beyond this ticket's completion notes
and any doc-comment updates in the files touched (matching this
codebase's convention of explaining non-obvious CSS/layout decisions
inline, as `RobotPage.css` already does for the Main tab).
