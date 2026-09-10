---
id: "005"
title: "Path trace panel with Clear action"
status: open
use-cases: [SUC-002]
depends-on: ["003"]
github-issue: ""
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Path trace panel with Clear action

## Description

Add a path-trace panel to `packages/ui/src/pages/RobotPage.tsx`, fed by
ticket 003's `useTelemetry(endpointId)`:
- Appends each decoded frame's `ox`/`oy` (already millimetres — do not
  scale) to a **client-side** trace buffer as points accumulate.
- Plots the accumulated trace.
- A **Clear** button empties the client-side trace buffer and resets
  the plot. This sends **no wire command** — the robot itself has no
  notion of "clear"; this is purely a client-side reset of the
  rendering buffer.
- When the current header does not include `ox`/`oy` (a real case:
  radio-robot-lib's own POSE/FULL fixtures carry no position columns),
  render an explicit "not available on this firmware" state instead of
  plotting garbage, defaulting to zero, or crashing.
- Before any header is held, render "waiting for header" (same
  discipline as ticket 004's Charts panel).

Read the `dataviz` skill before writing plotting code — same
palette/theme discipline as ticket 004.

Same transport-blindness constraint as ticket 004: read only
`WsProvider`/`useTelemetry` hooks; `RobotPage.transportBlind.test.ts`
must continue to pass unmodified in scope.

This panel maintains its **own** trace-point buffer, separate from
ticket 003's raw frame ring buffer — the trace needs `ox`/`oy` pairs
over a potentially longer window than the chart's rolling display, and
"Clear" must reset only the trace, not the underlying telemetry stream
or the Charts panel's own display.

## Acceptance Criteria

- [ ] The path trace accumulates `ox`/`oy` points from decoded frames,
      unscaled (a test asserts the plotted coordinate equals the raw
      wire value in mm).
- [ ] Clear empties the trace buffer and resets the plot; a test
      asserts no wire command is sent when Clear is pressed.
- [ ] When `ox`/`oy` are absent from the current header, the panel
      shows "not available on this firmware" rather than plotting or
      crashing (a test using a header without those columns, e.g. a
      radio-robot-lib POSE fixture's column set, confirms this).
- [ ] Before a header is held, the panel shows "waiting for header".
- [ ] `RobotPage.transportBlind.test.ts` passes unmodified.

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/pages` —
  `RobotPage.test.tsx` and `RobotPage.transportBlind.test.ts`.
- **New tests to write**: trace accumulation from a sequence of decoded
  frames; Clear resetting the buffer with no wire command sent; the
  "not available" state when `ox`/`oy` are absent; the "waiting for
  header" state.
- **Verification command**: `npx vitest run packages/ui`
