---
id: '004'
title: 'RobotPage Charts panel: wheel-speed bars and time-series chart'
status: done
use-cases:
- SUC-001
depends-on:
- '003'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RobotPage Charts panel: wheel-speed bars and time-series chart

## Description

Replace the stubbed Charts placeholder in `packages/ui/src/pages/
RobotPage.tsx` (`robot-page-charts-placeholder`) with a real panel fed
by ticket 003's `useTelemetry(endpointId)`:
- **Wheel-speed bars**: a compact live readout of wheel velocity
  column(s) present in the current header (names vary — the robot's
  own header may differ from radio-robot-lib fixtures; look the
  relevant column(s) up by name from the decoded frame and render
  "unavailable" if absent, rather than assuming a fixed position).
- **Time-series chart**: a rolling window over the ring buffer for one
  or more numeric columns.
- Before any header is held (`hasHeader` false), the panel renders an
  explicit "waiting for header" state — never a chart drawn against
  guessed columns.

Read the `dataviz` skill before writing any chart code: brand-neutral
placeholder palette, correct rendering in both light and dark themes,
consistent form/interaction with the rest of the app.

This panel, like every other panel on `RobotPage`, must read only
`WsProvider`/`useTelemetry` hooks — no transport-specific code, no
reference to `endpoint.transport`. `RobotPage.transportBlind.test.ts`
source-scans this file and must continue to pass unmodified in scope
(new source lines are fine; a new transport-specific reference is not).

Out of scope for this ticket: the path trace (ticket 005) — keep this
panel to wheel-speed bars and the time-series chart only, per the
sprint's own module boundary (Charts vs. Trace are separate SUCs and,
per the Architecture section, may be separate components even if they
share the same page column).

## Acceptance Criteria

- [x] The Charts placeholder text/element is replaced by a live panel;
      no dead "future work" copy remains for this feature.
- [x] Wheel-speed bars render from decoded frames and update as new
      frames arrive.
- [x] A time-series chart renders a rolling window of decoded values.
- [x] Before a header is held, the panel shows an explicit
      "waiting for header" state (verified by a test that mounts the
      panel with no header in the store).
- [x] A named column the current header does not include renders that
      one reading/series as explicitly unavailable, not a wrong value
      or a crash.
- [x] Charts are legible in both light and dark themes (per the
      `dataviz` skill's palette/contrast guidance).
- [x] `RobotPage.transportBlind.test.ts` passes unmodified.

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/pages` —
  `RobotPage.test.tsx` and `RobotPage.transportBlind.test.ts` must both
  continue to pass.
- **New tests to write**: a test mounting `RobotPage`/the Charts panel
  with a fake `useTelemetry` result for (a) no header, (b) a header
  with the expected wheel-velocity column(s), (c) a header missing
  them, and (d) a burst of frames driving a visible update.
- **Verification command**: `npx vitest run packages/ui`
