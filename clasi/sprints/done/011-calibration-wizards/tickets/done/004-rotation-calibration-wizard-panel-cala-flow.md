---
id: '004'
title: Rotation calibration wizard panel (cala flow)
status: done
use-cases:
- SUC-004
depends-on:
- '002'
- '003'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Rotation calibration wizard panel (cala flow)

## Description

`nezha-robot-template`'s `cala` routine (`test/calibratea.ts`) is a
fully autonomous rotation calibration with **no beam pointer and no
manual nudge control** — the roadmap's original description of this
wizard (`sprint.md`'s stale Solution text, corrected this sprint) does
not match this firmware. The robot spins clockwise, then
counter-clockwise, against a black-tape cross, timing white-to-black
edge crossings on one reflectance channel; it then **re-runs both
directions a second time with the correction applied**, as its own
built-in verification pass, and reports the residual error. It reports
progress and results the same way `calx` does: plain `CALA:` text lines
via `emitLine()`.

**Correction (post-close review, ticket 005's author): `CALA:apply
diffDrive.setConfigValue(ConfigField.RotationalSlip, <value>)` is
*not* the last line on the wire**, unlike `calx`'s identical-looking
terminal line. Reading `test/calibratea.ts` line by line: the routine
emits `apply` once the correction is computed, then immediately *sets*
that value and re-runs both directions a second time — `CALA:check
clockwise`/`CALA:check counter-clockwise` and their own progress lines
follow `apply` on the wire, not precede it. An earlier version of this
ticket's own Description (and this panel's first implementation)
assumed `apply` was the routine's last line, which caused
`deriveRotationCalibrationRun` to return at the first `apply` and never
render the two re-verification stages at all. The fix: `apply` still
marks the run `succeeded` (the snippet is known and shown), but
derivation keeps consuming the log slice afterward so `check-cw`/
`check-ccw` still populate and render; a `CALA:fail` arriving after
`apply` (the re-verification pass itself can fail) overrides the
outcome to `failed` and drops the snippet — a failed re-verification
must never leave a green result standing.

This ticket reuses ticket 003's `CalibrationReport.ts` parser (passing
it the `"CALA"` prefix) and builds the rotation wizard panel, which
differs from the distance wizard mainly in having **more distinct pass
stages to show** (CW measurement, CCW measurement, re-verification CW,
re-verification CCW) rather than in its underlying mechanics — though,
per the correction above, this wizard's `apply` handling is no longer
identical to `calx`'s: `calx`'s `CALX:apply` really is terminal,
`cala`'s `CALA:apply` is not.

**The snippet is never computed by this panel** — same rule as ticket
003: render the observed `CALA:apply ...` line verbatim, never a value
reconstructed from the intermediate `CALA:measured b=...`/`CALA:derived
slip=...` lines.

## Acceptance Criteria

- [x] `RotationCalibrationWizard.tsx` (new) fires the same one-shot
      `FUNCS` probe pattern as the distance wizard and enables Go only
      when `cala` is present in `device.functions`.
- [x] When `cala` is absent, the panel shows the same
      "doesn't support calibration yet" message, Go disabled.
- [x] The panel shows the black-tape-cross physical setup instructions
      (no beam pointer, no mention of nudging) before Go is usable.
- [x] Pressing Go sends `RUN cala` via `sendCommand`.
- [x] As `CALA:` lines arrive, the panel renders the CW pass, the CCW
      pass, and the firmware's own re-verification pass as distinct,
      visibly separate stages via `CalibrationReport` — not collapsed
      into one "running" spinner. **Corrected during review:** the two
      re-verification stages (`check clockwise`/`check
      counter-clockwise`) arrive AFTER the `CALA:apply` line on the real
      wire, not before it, and must still render even though the run is
      already `succeeded` by the time they stream in.
- [x] On a `CALA:apply ...` line, the panel renders that line's exact
      text as the snippet, byte-for-byte (after stripping the
      `CALA:apply ` prefix). **Corrected during review:** unlike ticket
      003's `CALX:apply`, `CALA:apply` is not the routine's last line —
      the panel keeps consuming the log after `apply` so the
      re-verification stages still populate, and a `CALA:fail` arriving
      after `apply` overrides the result to failed (dropping the
      snippet) rather than leaving a stale succeeded state standing.
- [x] On any `CALA:fail ...` line (e.g. "missed an arm, re-centre the
      robot", "STALLED, power-cycle the robot"), the panel renders a
      distinct failure state showing the reason text, no snippet — this
      holds whether the fail arrives before or after an `apply` line.
- [x] A `RUN` `err 1` reply renders a state distinguishable from both
      the `CALA:fail` state and the pre-run "unavailable" state.
- [x] No nudge control and no beam-pointer UI appears anywhere in this
      panel — this is the direct regression check for the roadmap's
      stale description of this specific wizard.
- [x] `RobotPage.transportBlind.test.ts`'s `FILES_UNDER_TEST` list
      includes `RotationCalibrationWizard.tsx`.

## Implementation Plan

**Approach:** same shape as ticket 003's distance wizard (`idle` →
`unavailable`|`ready` → `running` → `succeeded`|`failed`), with
`running` subdivided into the four visible pass stages named above,
derived from counting `CALA:pass ...`/`CALA:check ...` marker lines
already present in the routine's own emitted text (`CALA:pass
clockwise`, `CALA:pass counter-clockwise`, `CALA:check clockwise`,
`CALA:check counter-clockwise` — read directly from
`test/calibratea.ts`), not guessed at.

**Files to create:**
- `packages/ui/src/components/RotationCalibrationWizard.tsx`.
- `packages/ui/src/components/RotationCalibrationWizard.css` (if
  needed, matching sibling panels).

**Files to modify:**
- `packages/ui/src/pages/RobotPage.tsx` — mount
  `<RotationCalibrationWizard device={endpoint} />`.
- `packages/ui/src/pages/RobotPage.transportBlind.test.ts` — add the new
  file.

**Testing plan:**
- `RotationCalibrationWizard.test.tsx`: fake link/log fixtures covering
  every acceptance criterion, including a fixture log in the firmware's
  *real* emission order (cw, ccw, `apply`, then check-cw, check-ccw —
  **corrected during review**: an earlier draft of this plan called for
  `apply` as the final line, which does not match `test/calibratea.ts`
  and caused the re-verification stages to never render; see the
  Description's Correction note), and separate fixtures ending in a
  `fail` line at various stages (e.g. failing during the
  re-verification pass, not just the first, and failing *after* an
  `apply` line has already been seen).
- Re-run `RobotPage.transportBlind.test.ts`.
- Scoped run: `packages/ui/src/components/RotationCalibrationWizard.test.tsx`
  and `packages/ui/src/pages`, then `packages/ui` once.

**Documentation updates:** none directly (ticket 005).
