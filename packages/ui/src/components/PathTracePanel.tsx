/**
 * PathTracePanel.tsx — sprint 9 ticket 005: a top-down plot of the
 * robot's position trail, fed by ticket 003's `useTelemetry`/
 * `useTelemetryHeader` (SUC-002), mounted below `ChartsPanel` on
 * `RobotPage`.
 *
 * **Pose columns (OOP 2026-09-14).** The trail follows the firmware's
 * own pose, `x`/`y`/`h`, and falls back to the OTOS `ox`/`oy`/`oh` only
 * for a header without it -- see {@link POSE_COLUMN_SETS}. Both sets are
 * mm and centidegrees, so everything below applies to either; the plot
 * group flips y so +y (left of forward) is drawn up.
 *
 * **`ox`/`oy` are already millimetres — never scaled.** Per
 * `packages/protocol/src/v6/telemetry.ts`'s own doc comment ("Unit
 * conversion... `ox`/`oy` already mm... NOT divided") and the firmware
 * source (`vendor/pxt-nezha-diffdrive/src/comms/wire_adapter.cpp`:
 * `otosGet(0)/(1)` are already divided by 10 to mm before being placed
 * in the `ox`/`oy` columns), this panel stores exactly the `Number()`-
 * parsed wire value for each — no further scaling, unlike `ChartsPanel`'s
 * wheel-speed columns, which come in two candidate units. `oh`
 * (centidegrees) is likewise stored raw in this panel's own "latest
 * pose" ref and is only ever divided by 100 at the point it is turned
 * into a heading *angle* for the tick's geometry — a display-only
 * computation, not a rescaling of a plotted coordinate.
 *
 * **Own trace-point buffer, separate from `useTelemetry`'s frame ring.**
 * `WsProvider.tsx`'s `handleTelemetryMessage` clears that ring on every
 * `thdr` (header) message, including a re-announce of the same column
 * set — appropriate for the ring (a rolling window keyed to "what do
 * the currently-held columns mean"), but wrong for a trail a person
 * expects to persist until they press Clear. So this panel keeps its own
 * `TraceRing` of `{x, y}` points, appended from `useTelemetry`'s
 * `subscribe` callback (fired per frame, synchronously, outside React —
 * same seam `ChartsPanel` reads through) rather than from the frame
 * ring's own contents, and only that buffer is what Clear empties.
 *
 * **No per-frame React state.** Exactly `ChartsPanel`'s discipline (see
 * that module's own doc comment): `subscribe` schedules a
 * `requestAnimationFrame` draw only when a frame has actually arrived,
 * and the draw itself writes straight to SVG attributes held in refs
 * (the trail polyline's `points`, the current-pose marker's `cx`/`cy`,
 * the heading tick's endpoints, the plot `<svg>`'s own `viewBox`) —
 * never through `setState`. `header`/derived availability flags ARE
 * ordinary React state/memo, since they change at human speed.
 *
 * **Auto-scaled bounds via `viewBox`, not per-point remapping.** Rather
 * than normalizing each data point into a fixed `0..100` view space (the
 * way `ChartsPanel`'s time-series chart does, independently per axis),
 * this panel recomputes the `<svg>` element's own `viewBox` on every
 * draw to a square (equal width/height, hence equal x/y scale) that
 * encloses the accumulated trail, the fixed origin `(0, 0)`, and the
 * current pose, padded by {@link BOUNDS_PADDING_FRACTION} on every side.
 * The polyline's `points` attribute is then written with the *exact*
 * unscaled `x`/`y` values pushed into the trace buffer — the `viewBox`
 * does the zoom/pan, not the data. This is what makes "the plotted
 * coordinate equals the raw wire value in mm" a literal, directly
 * testable property of the DOM rather than something obscured behind a
 * screen-space transform.
 *
 * **Colour reuses `ChartsPanel`'s tokens (dataviz skill).** The trail is
 * a single series — per the dataviz skill, a single series needs no
 * legend — so it is drawn in `--rc-chart-series-1` (the same "identity"
 * blue `ChartsPanel` assigns its first series), the origin/grid reuse
 * `--rc-chart-baseline`/`--rc-chart-grid`, and the current-pose marker
 * uses `--rc-chart-positive` (the same accent `ChartsPanel`'s diverging
 * pair uses for a positive/forward reading) so the two panels read as
 * one system. `PathTracePanel.css` redeclares these `--rc-chart-*`
 * custom properties (values copied verbatim from `ChartsPanel.css`,
 * including its dark-mode overrides) scoped to `.path-trace-panel`,
 * since a CSS custom property does not cross between sibling elements —
 * each panel's stylesheet owns its own copy, exactly as `ChartsPanel.css`
 * already does relative to `theme.css`'s project-wide tokens.
 *
 * **Transport-blind.** Reads only `WsProvider`'s `useTelemetry`/
 * `useTelemetryHeader`/`useWsActions` hooks — never a transport-specific
 * type or field. Added to `RobotPage.transportBlind.test.ts`'s source
 * scan alongside `ChartsPanel.tsx`.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTelemetry, useTelemetryHeader, useWsActions, type TelemetryFrame } from "../ws/WsProvider";
import "./PathTracePanel.css";

export interface PathTracePanelProps {
  linkId: string;
}

interface TracePoint {
  x: number;
  y: number;
}

/** Which header columns carry the pose, in preference order. The
 * firmware's own pose (`x`/`y` mm, `h` centidegrees -- what a student's
 * `poseX()`/`poseY()`/`heading()` read) is in every POSE/FULL header
 * and moves on any robot; `ox`/`oy`/`oh` are the raw OTOS sensor and
 * read a constant `0 0 0` on a robot without one (bench capture
 * `gopiv-acceptance-028-20260902/step_e_transcript.txt`), which is why
 * a trace keyed on them alone never moved. The OTOS set remains a
 * fallback for a header that carries only those. */
const POSE_COLUMN_SETS = [
  { x: "x", y: "y", h: "h" },
  { x: "ox", y: "oy", h: "oh" },
] as const;

type PoseColumns = (typeof POSE_COLUMN_SETS)[number];

function findPoseColumns(header: readonly string[] | undefined): PoseColumns | undefined {
  if (!header) {
    return undefined;
  }
  return POSE_COLUMN_SETS.find((set) => header.includes(set.x) && header.includes(set.y));
}

/** One decoded pose, kept separately from {@link TraceRing} since the
 * ring only needs `x`/`y` for the trail itself, while the current-pose
 * marker and its heading tick also need the raw `oh` value (or
 * `undefined` when the current header carries no `oh` column). */
interface LatestPose extends TracePoint {
  headingCentidegrees: number | undefined;
}

/** How many trace points this panel retains before the oldest are
 * dropped — deliberately independent of (and much larger than)
 * `TELEMETRY_RING_CAPACITY` (600 frames, ~60s): per this ticket's
 * architecture note, the trail "needs `ox`/`oy` pairs over a potentially
 * longer window than the chart's rolling display." 20,000 points is
 * generous headroom for a long session (well over an hour at a typical
 * 10Hz telemetry rate) while still bounding memory instead of growing
 * without limit. Exported so tests can pin down the exact eviction
 * boundary, mirroring `TELEMETRY_RING_CAPACITY`'s own reasoning. */
export const TRACE_POINT_CAPACITY = 20_000;

/** Fraction of the tightest enclosing range added as padding on every
 * side of the auto-scaled `viewBox`, so the trail/current pose never sit
 * flush against the plot's edge. */
const BOUNDS_PADDING_FRACTION = 0.15;

/** Minimum data range (mm) used for the `viewBox` when the trail hasn't
 * moved far from the origin yet (including "no frames at all", where the
 * only point considered is the origin itself) — keeps the plot from
 * zooming in to an absurd degree on a near-zero range. */
const MIN_RANGE_MM = 200;

/** Marker radius and heading-tick length, each expressed as a fraction
 * of the current (padded) view range rather than a fixed mm value, so
 * both read at a consistent, legible size on screen whether the trail
 * spans a room or a corridor. */
const MARKER_RADIUS_FRACTION = 0.018;
const HEADING_TICK_FRACTION = 0.09;

interface ViewBox {
  minX: number;
  minY: number;
  range: number;
}

/** Compute the square, padded `viewBox` enclosing every trace point plus
 * the fixed origin `(0, 0)` and (when known) the current pose — equal
 * width/height is what gives the plot equal x/y scale, per this ticket's
 * acceptance criteria. Always includes the origin so `(0, 0)` — where
 * the robot's odometry started — never scrolls out of view even before
 * the trail has moved far from it. */
function computeViewBox(points: readonly TracePoint[], current: TracePoint | undefined): ViewBox {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  if (current) {
    minX = Math.min(minX, current.x);
    maxX = Math.max(maxX, current.x);
    minY = Math.min(minY, current.y);
    maxY = Math.max(maxY, current.y);
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const range = Math.max(rangeX, rangeY, MIN_RANGE_MM) * (1 + 2 * BOUNDS_PADDING_FRACTION);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { minX: centerX - range / 2, minY: centerY - range / 2, range };
}

/**
 * Fixed-capacity circular buffer for this panel's own trace-point
 * history — mirrors `WsProvider.tsx`'s `TelemetryRing` (O(1) push, no
 * `splice`/`shift` per point) but stores `{x, y}` pairs rather than full
 * telemetry frames. Not exported — {@link PathTracePanel} is the only
 * consumer.
 */
class TraceRing {
  private readonly buffer: (TracePoint | undefined)[];
  private start = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(point: TracePoint): void {
    const index = (this.start + this.count) % this.capacity;
    this.buffer[index] = point;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  snapshot(): TracePoint[] {
    const out: TracePoint[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.buffer[(this.start + i) % this.capacity]!);
    }
    return out;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

export function PathTracePanel({ linkId }: PathTracePanelProps) {
  const header = useTelemetryHeader(linkId);
  const telemetry = useTelemetry(linkId);
  const { clearTelemetry } = useWsActions();

  const hasHeader = header !== undefined;
  const poseColumns = useMemo(() => findPoseColumns(header), [header]);
  const hasPosition = poseColumns !== undefined;

  // Mirrors ChartsPanel's ref-mirroring pattern: the rAF-driven draw
  // closure below is set up once per mount (see the effect further
  // down) and reads this ref on every frame rather than closing over a
  // render's `poseColumns`, so a header change takes effect on the very
  // next frame without re-subscribing.
  const poseColumnsRef = useRef(poseColumns);
  poseColumnsRef.current = poseColumns;

  const traceRingRef = useRef<TraceRing | null>(null);
  if (!traceRingRef.current) {
    traceRingRef.current = new TraceRing(TRACE_POINT_CAPACITY);
  }
  const latestPoseRef = useRef<LatestPose | undefined>(undefined);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const trailRef = useRef<SVGPolylineElement | null>(null);
  const originRef = useRef<SVGCircleElement | null>(null);
  const currentPoseRef = useRef<SVGCircleElement | null>(null);
  const headingTickRef = useRef<SVGLineElement | null>(null);

  const draw = useCallback((): void => {
    const points = traceRingRef.current!.snapshot();
    const current = latestPoseRef.current;
    const viewBox = computeViewBox(points, current);

    if (svgRef.current) {
      // The plot's `<g>` flips y (robot frame: +y is left of forward,
      // drawn up), so the view's top edge is the data's max y, negated.
      svgRef.current.setAttribute(
        "viewBox",
        `${viewBox.minX} ${-(viewBox.minY + viewBox.range)} ${viewBox.range} ${viewBox.range}`,
      );
    }

    if (trailRef.current) {
      trailRef.current.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
    }

    const markerRadius = viewBox.range * MARKER_RADIUS_FRACTION;
    if (originRef.current) {
      originRef.current.setAttribute("r", markerRadius.toString());
    }

    if (currentPoseRef.current) {
      currentPoseRef.current.style.visibility = current ? "visible" : "hidden";
      if (current) {
        currentPoseRef.current.setAttribute("cx", current.x.toString());
        currentPoseRef.current.setAttribute("cy", current.y.toString());
        currentPoseRef.current.setAttribute("r", markerRadius.toString());
      }
    }

    if (headingTickRef.current) {
      const heading = current?.headingCentidegrees;
      const showTick = current !== undefined && heading !== undefined && Number.isFinite(heading);
      headingTickRef.current.style.visibility = showTick ? "visible" : "hidden";
      if (showTick && current) {
        const tickLength = viewBox.range * HEADING_TICK_FRACTION;
        const angle = (heading! / 100) * (Math.PI / 180);
        headingTickRef.current.setAttribute("x1", current.x.toString());
        headingTickRef.current.setAttribute("y1", current.y.toString());
        headingTickRef.current.setAttribute("x2", (current.x + tickLength * Math.cos(angle)).toString());
        headingTickRef.current.setAttribute("y2", (current.y + tickLength * Math.sin(angle)).toString());
      }
    }
  }, []);

  // Draw an initial baseline (origin marker + a default-sized viewBox)
  // as soon as the plot is actually mounted -- covers both "mounted with
  // a header that already has ox/oy" and "a header gains ox/oy later" --
  // without waiting for the first telemetry frame, which may be seconds
  // away or may never arrive if the operator never subscribes.
  useEffect(() => {
    if (hasPosition) {
      draw();
    }
  }, [hasPosition, draw]);

  useEffect(() => {
    let rafId: number | null = null;

    function scheduleDraw(): void {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          draw();
        });
      }
    }

    const unsubscribe = telemetry.subscribe((frame: TelemetryFrame) => {
      const columns = poseColumnsRef.current;
      if (!columns) {
        return;
      }
      const x = frame.values[columns.x];
      const y = frame.values[columns.y];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      traceRingRef.current!.push({ x, y });
      latestPoseRef.current = { x, y, headingCentidegrees: frame.values[columns.h] };
      scheduleDraw();
    });

    return () => {
      unsubscribe();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [telemetry, draw]);

  function handleClear(): void {
    // Client-side only, per this ticket's Description: the robot has no
    // notion of "clear", so nothing is sent over the wire here.
    traceRingRef.current!.clear();
    latestPoseRef.current = undefined;
    clearTelemetry(linkId);
    // Redraw synchronously (not via rAF) so the plot visibly resets the
    // instant Clear is pressed, rather than waiting for the next
    // telemetry frame to arrive and schedule one.
    draw();
  }

  return (
    <div className="path-trace-panel">
      {!hasHeader && (
        <p className="path-trace-panel-waiting" data-testid="path-trace-panel-waiting" role="status">
          Waiting for the robot&rsquo;s telemetry header (thdr) — no columns known yet.
        </p>
      )}

      {hasHeader && !hasPosition && (
        <p className="path-trace-panel-unavailable" data-testid="path-trace-unavailable">
          Position (x/y) not available on this firmware.
        </p>
      )}

      {hasHeader && hasPosition && (
        <>
          <div className="path-trace-panel-toolbar">
            <button type="button" className="path-trace-panel-clear" data-testid="trace-clear" onClick={handleClear}>
              Clear
            </button>
          </div>
          <div className="path-trace-panel-plot" data-testid="path-trace-plot">
            <svg
              ref={svgRef}
              viewBox={`${-MIN_RANGE_MM / 2} ${-MIN_RANGE_MM / 2} ${MIN_RANGE_MM} ${MIN_RANGE_MM}`}
              preserveAspectRatio="xMidYMid meet"
              className="path-trace-panel-svg"
              role="img"
              aria-label="Path trace"
            >
              <g transform="scale(1 -1)">
                <circle
                  ref={originRef}
                  className="path-trace-panel-origin"
                  data-testid="path-trace-origin"
                  cx={0}
                  cy={0}
                />
                <polyline
                  ref={trailRef}
                  className="path-trace-panel-trail"
                  data-testid="path-trace-trail"
                  points=""
                />
                <line
                  ref={headingTickRef}
                  className="path-trace-panel-heading-tick"
                  data-testid="path-trace-heading-tick"
                  style={{ visibility: "hidden" }}
                />
                <circle
                  ref={currentPoseRef}
                  className="path-trace-panel-current-pose"
                  data-testid="path-trace-current-pose"
                  style={{ visibility: "hidden" }}
                />
              </g>
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
