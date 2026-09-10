---
id: '003'
title: Distance calibration wizard panel (shared report parser + calx flow)
status: done
use-cases:
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Distance calibration wizard panel (shared report parser + calx flow)

## Description

`nezha-robot-template`'s `calx` routine (`test/calibratex.ts` in that
repo) is a fully autonomous, self-reporting distance calibration: it
creeps to a first black line, drives a known 90 cm gap, and reports the
corrected wheel-calibration constant as plain text lines emitted via
`emitLine()` — `CALX:begin ...`, `CALX:start line found`,
`CALX:measured=... true=90cm error=...`, `CALX:calib=... mm/deg (was
...)`, `CALX:diameter=... mm`, and finally `CALX:apply
diffDrive.setWheelCalibration(<value>)`. These are plain rx lines with
no `#id` and no `SET`/`GET` framing — `deviceRegistry.ts`'s
`link.onRawLine` handler already forwards exactly this kind of
non-protocol text into the endpoint's ordinary rx log (confirmed
reading that handler this sprint), the same log `CommandStrip` already
reads for its `GET`-reply harvesting.

This ticket builds two things: a small, shared, pure parser
(`CalibrationReport.ts`) that recognizes the common `<PREFIX>:` shape
(an `apply` line, a `fail` line, everything else as an opaque progress
event) — used by this wizard and by ticket 004's rotation wizard — and
the distance wizard panel itself, mounted on `RobotPage` unconditionally
(gated on `FUNCS` reporting `calx`, not on device classification — see
`sprint.md`'s Design Rationale, "wizard availability is `FUNCS`-gated,
not classification-gated").

**The snippet is never computed by this panel.** It is always the
verbatim text of the observed `CALX:apply ...` line. Do not parse
`CALX:calib=`/`CALX:diameter=` and reconstruct a call — render the
firmware's own line.

## Acceptance Criteria

- [x] `CalibrationReport.ts` (new, pure, no I/O, no React) parses one rx
      log line into one of: a progress event (any `<PREFIX>:...` line
      that isn't `apply` or `fail`, carrying the raw remainder text), an
      `apply` event (the full snippet text), a `fail` event (the reason
      text), or "not a calibration line" (anything not matching a known
      prefix) — this module accepts the prefix as a parameter (`"CALX"`
      or `"CALA"`), it is not `calx`-specific.
- [x] `DistanceCalibrationWizard.tsx` (new) fires a one-shot `FUNCS`
      probe on mount/reopen (mirroring `CommandStrip`'s existing
      mount/reopen pattern for its bare `GET`) and enables Go only when
      `calx` is present in the resulting `device.functions`.
- [x] When `calx` is absent, the panel shows a clear, non-alarming
      "this robot doesn't support calibration yet" message and Go stays
      disabled — never a spinner, never a timeout-shaped wait.
- [x] The panel shows the two-line, 90 cm physical setup instructions
      before Go is usable.
- [x] Pressing Go sends `RUN calx` via `sendCommand` (mirroring
      `FunctionsPanel`'s existing `RUN` dispatch for an arbitrary
      function).
- [x] As `CALX:` lines arrive in the endpoint's log (`useEndpointLog`,
      same source `CommandStrip` reads), the panel renders visible,
      distinct progress via `CalibrationReport` — at minimum "seeking
      first line" and "measuring second line" are distinguishable
      states, not one generic "running" spinner.
- [x] On a `CALX:apply ...` line, the panel renders that line's exact
      text as the copy-paste snippet — pinned by a test asserting the
      rendered text equals the fixture line's text byte-for-byte (after
      stripping the `CALX:apply ` prefix only).
- [x] On any `CALX:fail ...` line, the panel renders a distinct failure
      state (showing the reason text) and never renders a snippet.
- [x] A `RUN` `err 1` reply (a missing/wrong program name) renders a
      state distinguishable from both the `CALX:fail` state and the
      pre-run "unavailable" state.
- [x] No nudge control and no beam-pointer UI appears anywhere in this
      panel (this wizard's own regression check, since the roadmap's
      stale text described one for the *rotation* wizard, not this one,
      but the panel should not gain one by accident either).
- [x] `RobotPage.transportBlind.test.ts`'s `FILES_UNDER_TEST` list is
      updated to include `DistanceCalibrationWizard.tsx` and
      `CalibrationReport.ts`, and the scan continues to pass — no
      transport-specific reference in either new file.

## Implementation Plan

**Approach:** the panel is a thin state machine layered on capabilities
`RobotPage`'s existing panels already use — no new host/wire work (see
`sprint.md`'s Dependencies section: this sprint adds no new host-side
plumbing for the wizards). Structure the panel's own state as: `idle`
(pre-`FUNCS`) → `unavailable` | `ready` → `running` → `succeeded`
(holds the snippet) | `failed` (holds the reason).

**Files to create:**
- `packages/ui/src/components/CalibrationReport.ts` — the shared parser
  (see Acceptance Criteria for its exact contract).
- `packages/ui/src/components/DistanceCalibrationWizard.tsx` — the
  panel.
- `packages/ui/src/components/DistanceCalibrationWizard.css` (if styling
  needs a dedicated file, matching sibling panels' convention).

**Files to modify:**
- `packages/ui/src/pages/RobotPage.tsx` — mount
  `<DistanceCalibrationWizard device={endpoint} />` as one more panel.
- `packages/ui/src/pages/RobotPage.transportBlind.test.ts` — add the two
  new files to `FILES_UNDER_TEST`.

**Testing plan:**
- `CalibrationReport.test.ts`: table-driven over representative
  `CALX:`/`CALA:` fixture lines (progress, apply, fail, and a
  non-matching line), for both prefixes.
- `DistanceCalibrationWizard.test.tsx`: fake link/log fixtures covering
  every acceptance criterion above (FUNCS-gating, RUN dispatch,
  progressive rendering, apply-line snippet, fail-line state, `err 1`
  state).
- Re-run `RobotPage.transportBlind.test.ts` against the updated file
  list.
- Scoped run: `packages/ui`.

**Documentation updates:** none outside code doc comments — ticket 005
handles the `docs/design/usecases.md` correction separately, since that
correction covers both wizards together and is easier to review as one
change once both wizards' actual shapes are known.
