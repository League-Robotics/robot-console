/**
 * PathTracePanel.tsx — a top-down plot of the robot's position trail,
 * fed by `useTelemetry`/`useTelemetryHeader` (sprint 9 ticket 005,
 * SUC-002), with the current pose read out beneath it and the Drive
 * tab's recorded waypoints drawn on top (2026-10-17).
 *
 * **Pose columns.** The trail follows the firmware's own pose
 * (`x`/`y`/`h`) and falls back to the OTOS `ox`/`oy`/`oh` — see
 * `lib/pose.ts`. Both are mm and centidegrees, stored exactly as parsed
 * from the wire, never scaled; the plot group flips y so +y (left of
 * forward) is drawn up. Only the readout and waypoint labels convert to
 * cm/degrees, and only for display.
 *
 * **Own trace-point buffer, separate from `useTelemetry`'s frame ring.**
 * `WsProvider` clears that ring on every `thdr`, including a re-announce
 * of the same column set — wrong for a trail a person expects to persist
 * until they press Clear. So this panel keeps its own `TraceRing`,
 * appended from `useTelemetry`'s `subscribe` callback.
 *
 * **No per-frame React state.** `subscribe` schedules one
 * `requestAnimationFrame` draw per arrival, and the draw writes straight
 * to SVG attributes held in refs (trail `points`, marker `cx`/`cy`, the
 * `<svg>`'s own `viewBox`, the readout's text). Waypoints and the
 * selection ARE React state (they change at human speed); the draw only
 * resizes their markers to the current view range.
 *
 * **Auto-scaled bounds via `viewBox`.** Every draw recomputes a square
 * `viewBox` enclosing the trail, the origin, the current pose and every
 * waypoint, so the polyline's `points` are the exact wire values in mm —
 * "the plotted coordinate equals the raw wire value" is a literal DOM
 * property.
 *
 * **Transport-blind.** Reads only `WsProvider`'s hooks — never a
 * transport-specific type or field.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTelemetry, useTelemetryHeader, useWsActions, type TelemetryFrame } from "../ws/WsProvider";
import { findPoseColumns, formatCm, formatDeg, poseFromValues } from "../lib/pose";
import type { Waypoint } from "../lib/waypointCode";
import "./PathTracePanel.css";

export interface PathTracePanelProps {
  linkId: string;
  /** Enables Reset pose, which sends `SET rebase 1` (the firmware zeroes
   * x, y and heading) and clears the trail. */
  linkOpen?: boolean;
  waypoints?: readonly Waypoint[];
  selectedWaypointId?: number | null;
  onSelectWaypoint?: (id: number) => void;
}

interface TracePoint {
  x: number;
  y: number;
}

interface LatestPose extends TracePoint {
  headingCentidegrees: number | undefined;
}

/** How many trace points this panel retains before the oldest are
 * dropped — much larger than `TELEMETRY_RING_CAPACITY` (~60s), since a
 * trail needs a longer window than the chart's rolling display. */
export const TRACE_POINT_CAPACITY = 20_000;

const BOUNDS_PADDING_FRACTION = 0.15;

/** Minimum data range (mm) for the `viewBox`, so the plot never zooms
 * absurdly far in on a trail that has barely moved. */
const MIN_RANGE_MM = 200;

/** Marker radius, heading-tick length and label size as fractions of
 * the current view range, so they stay legible at any zoom. */
const MARKER_RADIUS_FRACTION = 0.018;
const HEADING_TICK_FRACTION = 0.09;
const WAYPOINT_LABEL_FRACTION = 0.035;

interface ViewBox {
  minX: number;
  minY: number;
  range: number;
}

function computeViewBox(points: readonly TracePoint[], current: TracePoint | undefined, extra: readonly TracePoint[]): ViewBox {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const include = (point: TracePoint) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  };
  points.forEach(include);
  extra.forEach(include);
  if (current) {
    include(current);
  }
  const range = Math.max(maxX - minX, maxY - minY, MIN_RANGE_MM) * (1 + 2 * BOUNDS_PADDING_FRACTION);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { minX: centerX - range / 2, minY: centerY - range / 2, range };
}

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

function formatPose(pose: LatestPose | undefined): string {
  if (!pose) {
    return "x — · y — · heading —";
  }
  const heading = pose.headingCentidegrees === undefined ? "—" : `${formatDeg(pose.headingCentidegrees)}°`;
  return `x ${formatCm(pose.x)} cm · y ${formatCm(pose.y)} cm · heading ${heading}`;
}

const NO_WAYPOINTS: readonly Waypoint[] = [];

export function PathTracePanel({
  linkId,
  linkOpen = false,
  waypoints = NO_WAYPOINTS,
  selectedWaypointId = null,
  onSelectWaypoint,
}: PathTracePanelProps) {
  const header = useTelemetryHeader(linkId);
  const telemetry = useTelemetry(linkId);
  const { clearTelemetry, sendCommand } = useWsActions();

  const hasHeader = header !== undefined;
  const poseColumns = useMemo(() => findPoseColumns(header), [header]);
  const hasPosition = poseColumns !== undefined;

  const poseColumnsRef = useRef(poseColumns);
  poseColumnsRef.current = poseColumns;
  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;

  const traceRingRef = useRef<TraceRing | null>(null);
  if (!traceRingRef.current) {
    traceRingRef.current = new TraceRing(TRACE_POINT_CAPACITY);
  }
  const latestPoseRef = useRef<LatestPose | undefined>(undefined);
  const viewRangeRef = useRef(MIN_RANGE_MM * (1 + 2 * BOUNDS_PADDING_FRACTION));

  const svgRef = useRef<SVGSVGElement | null>(null);
  const trailRef = useRef<SVGPolylineElement | null>(null);
  const originRef = useRef<SVGCircleElement | null>(null);
  const currentPoseRef = useRef<SVGCircleElement | null>(null);
  const headingTickRef = useRef<SVGLineElement | null>(null);
  const readoutRef = useRef<HTMLParagraphElement | null>(null);

  const draw = useCallback((): void => {
    const points = traceRingRef.current!.snapshot();
    const current = latestPoseRef.current;
    const marks = waypointsRef.current.map((w) => ({ x: w.xMm, y: w.yMm }));
    const viewBox = computeViewBox(points, current, marks);
    viewRangeRef.current = viewBox.range;

    const svg = svgRef.current;
    if (svg) {
      svg.setAttribute("viewBox", `${viewBox.minX} ${-(viewBox.minY + viewBox.range)} ${viewBox.range} ${viewBox.range}`);
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

    if (svg) {
      const labelSize = (viewBox.range * WAYPOINT_LABEL_FRACTION).toString();
      for (const marker of svg.querySelectorAll<SVGCircleElement>(".path-trace-panel-waypoint-marker")) {
        marker.setAttribute("r", markerRadius.toString());
      }
      for (const label of svg.querySelectorAll<SVGTextElement>(".path-trace-panel-waypoint-label")) {
        label.setAttribute("font-size", labelSize);
        label.setAttribute("dx", (markerRadius * 1.4).toString());
        label.setAttribute("dy", (markerRadius * 1.4).toString());
      }
    }

    if (readoutRef.current) {
      readoutRef.current.textContent = formatPose(current);
    }
  }, []);

  useEffect(() => {
    if (hasPosition) {
      draw();
    }
  }, [hasPosition, waypoints, draw]);

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
      const pose = poseFromValues(frame.values, columns);
      if (!pose) {
        return;
      }
      traceRingRef.current!.push({ x: pose.xMm, y: pose.yMm });
      latestPoseRef.current = { x: pose.xMm, y: pose.yMm, headingCentidegrees: pose.headingCentideg };
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
    traceRingRef.current!.clear();
    latestPoseRef.current = undefined;
    clearTelemetry(linkId);
    draw();
  }

  function handleResetPose(): void {
    sendCommand(linkId, "SET", ["rebase", "1"]);
    handleClear();
  }

  const markerRadius = viewRangeRef.current * MARKER_RADIUS_FRACTION;
  const labelSize = viewRangeRef.current * WAYPOINT_LABEL_FRACTION;

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
            <p className="path-trace-panel-readout" data-testid="path-trace-pose-readout" ref={readoutRef}>
              {formatPose(undefined)}
            </p>
            <div className="path-trace-panel-buttons">
              <button
                type="button"
                className="path-trace-panel-clear"
                data-testid="trace-reset-pose"
                disabled={!linkOpen}
                title="Set the robot's position to (0, 0) and heading to 0"
                onClick={handleResetPose}
              >
                Reset pose
              </button>
              <button type="button" className="path-trace-panel-clear" data-testid="trace-clear" onClick={handleClear}>
                Clear
              </button>
            </div>
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
                <circle ref={originRef} className="path-trace-panel-origin" data-testid="path-trace-origin" cx={0} cy={0} />
                <polyline ref={trailRef} className="path-trace-panel-trail" data-testid="path-trace-trail" points="" />
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
                {waypoints.map((w) => {
                  const selected = w.id === selectedWaypointId;
                  return (
                    <g
                      key={w.id}
                      className={`path-trace-panel-waypoint${selected ? " path-trace-panel-waypoint-selected" : ""}`}
                      data-testid={`path-trace-waypoint-${w.n}`}
                      data-selected={selected ? "true" : "false"}
                      onClick={() => onSelectWaypoint?.(w.id)}
                    >
                      <circle className="path-trace-panel-waypoint-marker" cx={w.xMm} cy={w.yMm} r={markerRadius} />
                      <text
                        className="path-trace-panel-waypoint-label"
                        transform={`translate(${w.xMm} ${w.yMm}) scale(1 -1)`}
                        fontSize={labelSize}
                        dx={markerRadius * 1.4}
                        dy={markerRadius * 1.4}
                      >
                        {`${w.n} (${formatCm(w.xMm)}, ${formatCm(w.yMm)})`}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
