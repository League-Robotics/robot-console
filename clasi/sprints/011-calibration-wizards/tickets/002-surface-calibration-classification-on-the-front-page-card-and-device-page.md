---
id: '002'
title: Surface calibration classification on the front-page card and device page
status: open
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: id-verb-distinguishes-calibration-from-student-robots.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Surface calibration classification on the front-page card and device page

## Description

Ticket 001 makes `classification.type === "calibration"` a real,
distinguishable value. Nothing in the UI reads it yet. This ticket adds
the two purely additive consumption points the linked issue's
Verification section asks for: a distinguishing label on the
front-page card, an additive `DevicePage` dispatch arm so a
`calibration`-classified endpoint reaches `RobotPage` at all (today it
would fall through to the `default -> UnknownDevicePage` arm, since
`DeviceType` gained a member `DevicePage`'s `switch` doesn't yet know),
and the raw `program`/`version` diagnostics visible somewhere on
`RobotPage`.

This ticket is a hard dependency for tickets 003/004: until
`DevicePage` routes `"calibration"` to `RobotPage`, a
calibration-classified robot's wizard panels (built in those tickets)
are unreachable in the running app, even though their own component
tests don't require this ticket to pass.

## Acceptance Criteria

- [ ] `FrontPage`'s `EndpointCard` renders a distinguishing label (e.g.
      "Calibration robot") for `classification.type === "calibration"`,
      leaving the existing `"robot"` label/rendering unchanged.
- [ ] `DevicePage.tsx`'s dispatch gains `case "calibration": return
      <RobotPage .../>`, additive alongside the existing `"robot"` arm
      — no existing arm (`"relay"`, `"unknown"`, `"robot"`) changes
      behavior.
- [ ] `RobotPage` displays the raw `classification.program` and
      `classification.version` strings somewhere visible (diagnostics,
      per the linked issue's Verification section) when they are
      non-null; renders nothing extra when they are null (a robot that
      never answered `ID`).
- [ ] A `classification.type === "robot"` fixture (the ordinary case)
      is unaffected by every change above — pinned by a regression
      assertion, not just "not covered by a new test."

## Implementation Plan

**Approach:** three small, independent-in-code additive changes, each
mirroring an existing pattern in the same file rather than inventing a
new one (front-page cards already vary by classification for
`"relay"`/`"robot"`/`"unknown"`; `DevicePage`'s dispatch is already a
plain `switch`/lookup on `classification.type`).

**Files to modify:**
- `packages/ui/src/pages/FrontPage.tsx` — `EndpointCard`'s existing
  type-based label logic gains a `"calibration"` case.
- `packages/ui/src/pages/DevicePage.tsx` — one new `case "calibration"`
  arm, rendering the same `<RobotPage endpoint={endpoint} />` the
  `"robot"` arm renders.
- `packages/ui/src/pages/RobotPage.tsx` — a small diagnostics line/badge
  reading `endpoint.classification.program`/`.version`, rendered
  conditionally on non-null (placed near the existing `<h2>` name
  heading, not inside any panel, so it's visible regardless of which
  panels a given build ships).

**Testing plan:**
- `FrontPage.test.tsx`: a `calibration`-classified fixture card shows
  the distinguishing label; a `robot`-classified fixture is unchanged
  (regression).
- `DevicePage.test.tsx`: a `calibration`-classified fixture renders
  `RobotPage`'s content (assert on something `RobotPage`-specific, e.g.
  its `aria-label="Robot device"` section); existing `relay`/`robot`/
  `unknown` fixture tests continue to pass unmodified.
- `RobotPage.test.tsx`: a fixture with `program`/`version` set renders
  both strings; a fixture with both `null` renders no diagnostics line
  (assert its absence, not just that nothing throws).
- Scoped run: `packages/ui`, not the full suite.

**Documentation updates:** none beyond in-code doc comments on the
three changed files, following each file's own existing comment
convention (see e.g. `FrontPage.tsx`'s and `DevicePage.tsx`'s existing
module-level doc comments for the style to match).
