---
status: pending
---

# Drive tab: tighten the layout, drop the wheel-speed bars, record waypoints

## Stakeholder request (2026-10-17)

Three things on the Drive tab, given together:

1. **Drop the wheel-speed bars.** "We don't need that wheel speed left
   and right. We don't need that at all." The `ChartsPanel` "Wheel
   speed" section (the Left/Right diverging bars) goes away entirely.
2. **Tighten the layout.** "There is a bunch of empty space just off to
   the right of the drive controls cluster." Move the chart's controls
   (the OFF/POSE/FULL telemetry mode buttons and the time-series column
   selector) into that space, to the right of the pad. "The time series
   and the chart's controls, you can put them on two lines." The
   time-series selector sits to the right of the OFF/POSE/FULL buttons.
   The path trace and the current position go "right underneath, on
   the bottom part of the left side." That leaves the right column for
   recording.
3. **Record waypoints.** A **Record** button records the current pose as
   a numbered waypoint. On the path trace each waypoint is drawn in a
   distinct colour or symbol, labelled with its number and its
   coordinates in parentheses. Clicking a waypoint highlights it, and a
   highlighted waypoint can be deleted. The right column has the Record
   button at the top and, below it for the whole column height, the
   list of waypoints with the same numbers; waypoints can be selected
   and deleted from the list too. Next to Record, a toggle expresses
   the waypoints as **positions**, as **drive commands**, or as **go-to
   commands**, and a **Copy** button copies that text "so I can paste
   them into my own code."

## Current state (for whoever plans this)

- `packages/ui/src/components/DriveTab.tsx` lays the tab out with
  `RobotPage.css`'s `.robot-page-columns` (two equal `1fr` columns).
  Left: `DriveControls` pad, keyboard/gamepad aids, Functions panel.
  Right (`.robot-page-column-console`, sticky and viewport-tall):
  Charts panel, then the path trace filling to the bottom.
- `ChartsPanel.tsx` owns the OFF/POSE/FULL mode buttons
  (`data-testid="telemetry-mode"`), the wheel-speed bars
  (`wheel-speed-bars`, `wheel-speed-left/right`, `wheel-speed-unavailable`),
  the column picker (`chart-column-picker`) and the time-series SVG.
  `WHEEL_SPEED_CANDIDATES`/`findWheelCandidate` exist only for the bars
  and for the picker's default selection (`vl`/`vr` when present).
- `PathTracePanel.tsx` keeps its own `TraceRing` of `{x, y}` (mm) and a
  `latestPoseRef` with `headingCentidegrees`, draws imperatively via
  rAF into an auto-scaled square `viewBox` with a `scale(1 -1)` group,
  and has a Clear toolbar. There is no on-screen readout of the current
  pose today; the stakeholder's "current positions" under the trace is
  new.
- Telemetry pose units are **mm** and **centidegrees** (`x`/`y`/`h`,
  falling back to `ox`/`oy`/`oh`). The MakeCode API students paste into
  is in **cm** and **degrees**: `diffDrive.move(distanceCm, yawDeg)`,
  `diffDrive.goTo(xCm, yCm)` (robot frame: x forward, y left) and
  `diffDrive.goToWorld(xCm, yCm)` (world frame, same frame as the pose
  the trace plots). Conversion belongs in one place, like
  `programCode.ts` already does for setup code.

## Proposed shape

- **Layout.** Left column, top row: the pad as today, and beside it a
  two-line control block: line 1 OFF/POSE/FULL with the column selector
  to its right; line 2 the time-series chart. Left column, bottom: the
  path trace with a one-line current-pose readout (x, y in cm, heading
  in degrees). The aids and Functions panel keep their place in the
  left column. Right column: Record, the format toggle and Copy on one
  row, then the waypoint list filling the rest of the column (this is
  the column that keeps `.robot-page-column-console`).
- **Waypoint model.** A list of `{ id, n, xMm, yMm, headingCentideg }`
  held in `DriveTab` (React state, human-speed) and passed to both the
  trace and the list, so the trace's markers and the list agree on
  numbering and selection. Numbers are assigned on record and never
  reused after a delete, so a number on the plot always means the same
  point in the copied text.
- **Trace markers.** Rendered as React children inside the flipped
  group, one `<g>` per waypoint: a marker in a colour distinct from the
  trail and current-pose marker, plus a text label `n (x, y)` in cm.
  Labels must counter the `scale(1 -1)` flip and use
  `vector-effect`/a computed font size from the view range so they stay
  legible as the viewBox rescales. Click selects; the selected waypoint
  is highlighted on both the plot and the list.
- **Export formats** (one pure function in `lib/`, unit-tested):
  - *positions*: one line per waypoint, `// 1: x 12.3 cm, y -4.5 cm,
    heading 90 deg` or a small array literal; exact form is the
    planner's call.
  - *go-to commands*: `diffDrive.goToWorld(x, y)` per waypoint, in cm,
    in order.
  - *drive commands*: `diffDrive.move(distance, yaw)` legs between
    consecutive waypoints, from the origin pose: first the yaw needed
    to face the next point from the current heading, then the straight
    distance. Needs the stakeholder to confirm whether each leg should
    be one `move(d, yaw)` arc or a `move(0, yaw)` pivot followed by
    `move(d, 0)`.
- **Copy** uses `navigator.clipboard.writeText` with a visible
  "Copied" confirmation and a fallback when the clipboard API is
  unavailable.

## Tests affected

- `ChartsPanel.test.tsx`: the "wheel-speed bars" and "header missing
  wheel-speed columns" describes go; the subscribe-control, waiting,
  column-selection and rAF-unmount tests stay.
- `DriveTab.test.tsx`: layout assertions for the moved controls, the
  Record/list/delete/select flow, the format toggle and Copy output.
- `PathTracePanel.test.tsx`: waypoint markers render at the exact mm
  coordinates passed in (same "plotted coordinate equals wire value"
  property the trail already pins), labels show cm, click selects.
- New `lib/waypointCode.test.ts` (or similar) for the three formats.

## Open questions for the stakeholder

- Drive-command form: one arc per leg, or pivot then straight?
- Should waypoints survive a path-trace Clear, a header change, or
  navigating away from the tab? (Default proposal: Clear leaves them;
  leaving the tab drops them.)
- Positions format: comment lines, or an array literal a program can
  iterate?

## Resolution (2026-10-17)

Done out of process in one commit. Decisions on the open questions,
taken without the stakeholder and easy to change:

- Drive-command form: pivot then straight (`move(0, yaw)` then
  `move(d, 0)`), the way `goToWorld` itself turns first; the pivot is
  skipped when already facing the point.
- Positions format: an array literal (`[x cm, y cm, heading deg]` per
  line, numbered in a trailing comment) so a program can iterate it.
- Waypoints survive a path-trace Clear and a header change; leaving the
  tab drops them. Numbers are never reused after a delete.
- The list shows each waypoint in the selected format, so the toggle
  is visible before Copy. Delete/Backspace removes the selected
  waypoint when no text field has focus.
