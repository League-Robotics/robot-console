---
id: '001'
title: Unify the code-for-your-program block into one shared generator used by both
  tabs
status: done
use-cases:
- SUC-005
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Unify the code-for-your-program block into one shared generator used by both tabs

## Description

Today the Calibration tab and the Configuration tab show two different
"Code for your program" blocks. `CalibrationPage.tsx` calls
`calibrationCode(state, robotName, options)` from `lib/calibration.ts`
directly, which only ever emits calibration lines. `ConfigurationPage.tsx`
has its own unexported `configurationCode(input)` that emits radio
(`diffDrive.setupRadio`) and WiFi (`diffDrive.setupWifi`) lines, then
splices in `calibrationCode`'s own output (minus its header comment).
The stakeholder wants one program: "the Calibration Code for Your
Program section should also include Wi-Fi" and should "be using the
same code for that section as the configuration page."

Move `configurationCode`, `MASKED_PASSWORD`, and `jsString` out of
`ConfigurationPage.tsx` into a new `packages/ui/src/lib/programCode.ts`
(a pure function, no React, no store access — see sprint.md's
Architecture §Step 3, module 5). Both pages then call this one function
for what they display. `CalibrationPage` needs two things it doesn't
have today to call it meaningfully:

- **Radio**: already available — `CalibrationPage` already receives a
  `device: SnapshotDevice` prop, and `device.radio` is the same field
  `ConfigurationPage` reads. No new plumbing needed here.
- **WiFi**: `useWifiCredentials()` is a global `WsProvider` hook,
  callable from any component — but the store slice it reads is only
  ever populated by a `get-wifi-credentials` request, and today only
  `ConfigurationPage` fires that request (in a `useEffect` gated on
  `useConnectionStatus()`). A student who calibrates without ever
  opening the Configuration tab would see the WiFi line blank forever.
  Move that request effect up to `RobotPage.tsx` (the nearest common
  ancestor of both tabs), so it fires once per robot session
  regardless of which tab is opened first.

Also fix the presentation: `.calibration-code` currently renders
`white-space: pre` with `overflow-x: auto` and no vertical-sizing rule
of its own (`CalibrationPage.css`), which is exactly what produced the
stakeholder's screenshot of a block clipped mid-comment with a
horizontal scrollbar. Change it to wrap (`white-space: pre-wrap`,
`overflow-wrap`/`word-break` as needed for the long single-line
provenance comments in `calibrationCode`'s output) and to grow to fit
its content rather than being capped by the surrounding column's own
height rule, on both tabs.

Per this codebase's house style, explain in comments *why* the request
effect moved and *why* `programCode.ts` is a pure function with no
React/store dependency of its own (so it stays trivially unit-testable
the way `calibrationCode` already is).

## Acceptance Criteria

- [x] `packages/ui/src/lib/programCode.ts` exports `configurationCode`
      (or a renamed equivalent — keep the exported shape stable enough
      that existing tests port cleanly), `MASKED_PASSWORD`, and
      `jsString`, moved verbatim in behavior from `ConfigurationPage.tsx`.
      (Renamed to `programCode`, per sprint.md's Architecture §3 module 5
      and SUC-005's own acceptance criteria, both of which name the
      function `programCode()`.)
- [x] `ConfigurationPage.tsx` no longer defines these itself; it imports
      them from `lib/programCode.ts` and its own rendering/Copy-button
      behavior is unchanged.
- [x] `CalibrationPage.tsx` renders the same generator's output (radio +
      WiFi + calibration lines) instead of calling `calibrationCode`
      directly for its displayed block. (`calibrationCode` itself is
      unmodified — `programCode.ts` still calls it internally, per
      sprint.md's Out of Scope: "no change to what `calibrationCode()`
      itself computes.")
- [x] The `get-wifi-credentials` request effect moves from
      `ConfigurationPage.tsx` to `RobotPage.tsx`, fires once per robot
      session, and both tabs see WiFi data regardless of which is
      opened first.
- [x] `.calibration-code` wraps long lines instead of scrolling
      horizontally, and its container is not height-capped below the
      number of lines the code actually has, on both tabs.
- [x] The Copy button's behavior (text copied, "Copied" feedback) is
      unchanged on both tabs.
- [x] A robot with an unset WiFi password shows the existing
      `MASKED_PASSWORD` placeholder and "password not known to this
      computer" comment on the Calibration tab exactly as it already
      does on the Configuration tab.

## Implementation Plan

**Approach**: Pure relocation-and-reuse, no change to what
`calibrationCode()` computes. Move code first (mechanical), then wire
`CalibrationPage` to it, then move the WiFi-request effect, then fix
CSS. Keep each step's tests green before moving to the next so a
regression is easy to bisect.

**Files to create**:
- `packages/ui/src/lib/programCode.ts` — `configurationCode`,
  `MASKED_PASSWORD`, `jsString`, moved from `ConfigurationPage.tsx`.
- `packages/ui/src/lib/programCode.test.ts` — ported from
  `ConfigurationPage.test.tsx`'s existing `configurationCode` cases,
  plus new cases for calling it from a Calibration-tab-shaped input
  (no `ConfigurationPage`-specific state involved).

**Files to modify**:
- `packages/ui/src/components/ConfigurationPage.tsx` — remove the
  three moved exports, import them from `lib/programCode.ts` instead;
  remove the `get-wifi-credentials` request effect (moved to
  `RobotPage.tsx`).
- `packages/ui/src/components/CalibrationPage.tsx` — call
  `programCode()` (sourcing `radio` from `device.radio`, `wifi` from
  `useWifiCredentials()`) instead of `calibrationCode()` directly for
  the displayed block; update the `calibration-code-panel` rendering
  if the CSS class changes.
- `packages/ui/src/components/CalibrationPage.css` — wrap instead of
  scroll, remove/relax any height cap on `.calibration-code`'s
  container.
- `packages/ui/src/pages/RobotPage.tsx` — add the
  `get-wifi-credentials` request effect (gated on
  `useConnectionStatus()`, same shape as the one being removed from
  `ConfigurationPage.tsx`).
- `packages/ui/src/components/ConfigurationPage.test.tsx` — update
  imports for the moved functions; remove assertions on the
  now-relocated request effect if any exist there (they move to
  `RobotPage.test.tsx`).
- `packages/ui/src/components/CalibrationPage.test.tsx` — add
  assertions that the block includes radio/WiFi lines, not just
  calibration lines.
- `packages/ui/src/pages/RobotPage.test.tsx` — add a test asserting
  `get-wifi-credentials` is requested once per robot session.

**Testing plan**: Run `npm test -- programCode ConfigurationPage
CalibrationPage RobotPage` (vitest, scoped to touched modules, in the
foreground) after each step. Full suite runs once at `close_sprint`,
not per ticket.

**Documentation updates**: None required outside this ticket's own
code comments — `docs/design/` is out of scope for this UI-only change
per sprint.md's Architecture, and no `docs/design/architecture.md`
section describes this UI-level detail today.

## Testing

- **Existing tests to run**: `packages/ui` vitest suite scoped to
  `programCode`, `ConfigurationPage`, `CalibrationPage`, `RobotPage`
  (`npm test -- programCode ConfigurationPage CalibrationPage RobotPage`
  from `packages/ui`, foreground only).
- **New tests to write**: `lib/programCode.test.ts` (ported +
  extended); new `CalibrationPage.test.tsx` cases for radio/WiFi
  presence and wrapping; new `RobotPage.test.tsx` case for the moved
  WiFi-credentials request.
- **Verification command**: `npm test -- programCode ConfigurationPage
  CalibrationPage RobotPage` (run from `packages/ui`; this project uses
  `npm`/`vitest`, not `pytest` — the template's default command does
  not apply to this repo).
