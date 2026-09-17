/**
 * ChartsPanel.tsx — replaces `RobotPage`'s stubbed Charts placeholder
 * with wheel-speed bars and a rolling time-series chart, fed entirely
 * by ticket 003's `useTelemetry`/`useTelemetryHeader` (sprint 9 ticket
 * 004 / SUC-001). The path-trace panel is ticket 005's job, out of
 * scope here (`sprint.md`'s Architecture: Charts and Trace are separate
 * SUCs and may be separate components even though they share this
 * page's left column).
 *
 * **Schemaless by construction.** `thdr` is decoded host-side with no
 * fixed column table (`packages/protocol/src/v6/telemetry.ts`), so this
 * panel never assumes a column exists at a fixed position — it looks up
 * every column it cares about *by name* in whatever header the current
 * robot actually sent, and renders an explicit "unavailable"/"waiting
 * for header" state rather than guessing or crashing when a name is
 * missing (ticket 004's acceptance criteria).
 *
 * **Wheel-speed column names vary by firmware.** This repo's own
 * vendored firmware (`vendor/pxt-nezha-diffdrive/src/comms/
 * wire_adapter.cpp`) emits `vl`/`vr` (plain `[mm/s]`, per
 * `wire_adapter.cpp`'s own unit comment on `wheelSpeed()`).
 * `radio-robot-lib`'s protocol doc (`docs/design/protocol.md` §10.2's
 * worked `thdr`/`t` example, and its archived full-robot table in
 * §10.4) instead uses `vell`/`velr` (`[mm/s x10]`). Neither name is
 * "the" wheel-speed column — {@link WHEEL_SPEED_CANDIDATES} tries both
 * pairs, in order, against whatever header is currently held, and the
 * first pair fully present wins. A header with neither pair renders the
 * explicit unavailable text below rather than a wrong reading.
 *
 * **No per-frame React state (this module's whole point).**
 * `useTelemetry`'s ring can receive tens of frames a second
 * (`WsProvider.tsx`'s own doc comment); routing each one through
 * `useState` would re-render this panel at that rate. Instead, a single
 * effect subscribes once (via `telemetry.subscribe`) and schedules a
 * `requestAnimationFrame` draw only when a frame has actually arrived
 * since the last draw — the rAF loop is arrival-driven, not a
 * perpetual per-frame timer, so it does no work between frames and does
 * not run at all before the first frame. The draw itself writes
 * directly to DOM nodes held in refs (bar widths, an SVG path's `d`,
 * label text content) — never through `setState` — so React's render
 * cycle is untouched by telemetry traffic. `header`/mode/column
 * selection ARE ordinary React state, since they change at human speed,
 * not telemetry speed.
 *
 * **Subscribe control does not auto-subscribe.** Mode starts `"OFF"`;
 * nothing is sent to the robot until a person presses POSE or FULL —
 * ticket 004 does not ask for an on-mount subscribe, and guessing one
 * would make every `RobotPage` visit start driving robot-side telemetry
 * traffic with no explicit action behind it.
 *
 * **Time-series axis stays single (no dual-axis).** All currently
 * selected columns share one linear y-scale computed from their own
 * window of values — the dataviz skill's "one axis, never two y-scales"
 * rule holds even though arbitrary columns can have very different
 * native ranges; a column whose scale dwarfs the others will simply
 * read flat, which is a column-selection concern for whoever picks it,
 * not a chart design flaw this panel should paper over with a second
 * axis.
 *
 * **Color, per the `dataviz` skill's reference palette
 * (`references/palette.md`):** the two default wheel channels are
 * identity-coded with the categorical palette's first two slots (blue
 * "left", orange "right" — never cycled, assigned in the palette's
 * fixed order); the diverging blue<->red pair marks each bar's sign
 * (forward vs. reverse) since direction is a polarity, not an
 * identity. Chart chrome (surface/ink/gridline/baseline) reuses this
 * palette's documented hex steps for both light and dark, declared as
 * local custom properties in `ChartsPanel.css` (mapped onto this
 * project's existing `--rc-*` semantic tokens where one already exists
 * — surface, border, text — and as new `--rc-chart-*` tokens where the
 * project has no chart-specific slot yet, e.g. categorical series
 * colors). Both a legend and, for at most `MAX_CHART_SERIES` (4)
 * series, direct end-of-line labels are shown, so identity never rests
 * on color alone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useTelemetry,
  useTelemetryHeader,
  useWsActions,
  type TelemetryFrame,
  type TelemetryMode,
} from "../ws/WsProvider";
import "./ChartsPanel.css";

export interface ChartsPanelProps {
  linkId: string;
}

/** Every mode this panel's subscribe control offers — `"HDR"` (re-ask
 * for just the header) is a `WsActions.telemetrySubscribe` value too,
 * but has no button here; a person only ever needs to pick a data
 * stream, not trigger the gap-recovery request `deviceRegistry.ts`
 * already issues on its own. */
const MODES: readonly TelemetryMode[] = ["OFF", "POSE", "FULL"];

interface WheelSpeedCandidate {
  left: string;
  right: string;
  unit: string;
  /** Roughly the largest magnitude this channel is expected to reach —
   * only used to size the bar's fill against a fixed domain, not a wire
   * limit of any kind. */
  maxMagnitude: number;
}

/** See this module's doc comment ("Wheel-speed column names vary by
 * firmware") for why two candidate pairs exist and why order matters:
 * the first pair fully present in the header wins. */
const WHEEL_SPEED_CANDIDATES: readonly WheelSpeedCandidate[] = [
  { left: "vl", right: "vr", unit: "mm/s", maxMagnitude: 1000 },
  { left: "vell", right: "velr", unit: "mm/s ×10", maxMagnitude: 10000 },
];

/** How much history the time-series chart shows, regardless of how much
 * the ring itself retains (`TELEMETRY_RING_CAPACITY`, ~60s) — a shorter
 * rolling window reads as "now-ish trend", which is this chart's job. */
const CHART_WINDOW_MS = 15_000;

/** Categorical palette slot cap for the time-series chart — the
 * dataviz skill's default order clears every adjacent-pair CVD/contrast
 * gate in both themes for a run this short; a 5th slot is deliberately
 * refused rather than cycling a hue or reaching past the validated
 * order (`references/palette.md`). */
const MAX_CHART_SERIES = 4;

/** Fixed, validated categorical order (dataviz skill's
 * `references/palette.md`) — assigned to selected columns in the order
 * they were selected, never re-cycled or re-sorted by value, so a
 * column's color stays stable across a redraw. */
const SERIES_CLASSES = ["series-1", "series-2", "series-3", "series-4"] as const;

/** Return the first {@link WHEEL_SPEED_CANDIDATES} entry both of whose
 * columns the header actually has, or `undefined` if none match — the
 * "no wheel-speed columns in this header" case ticket 004 calls for
 * instead of a crash or a guessed reading. */
function findWheelCandidate(
  header: readonly string[] | undefined,
): WheelSpeedCandidate | undefined {
  if (!header) {
    return undefined;
  }
  for (const candidate of WHEEL_SPEED_CANDIDATES) {
    if (header.includes(candidate.left) && header.includes(candidate.right)) {
      return candidate;
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatValue(value: number): string {
  return Number.isFinite(value) ? value.toFixed(0) : "—";
}

/** Writes a diverging bar's fill: length from center proportional to
 * `|value| / maxMagnitude` (clamped to the track), extending right for
 * a positive value and left for a negative one, colored via this
 * module's diverging pair (`ChartsPanel.css`'s
 * `.charts-panel-bar-fill-positive`/`-negative`) so the sign — forward
 * vs. reverse — reads as color, and magnitude reads as length.
 * `value === undefined` (no frame yet) collapses the fill to zero width
 * rather than leaving a stale reading from a previous render. */
function setBarFill(el: HTMLDivElement, value: number | undefined, maxMagnitude: number): void {
  if (value === undefined || !Number.isFinite(value)) {
    el.style.width = "0%";
    el.style.left = "50%";
    return;
  }
  const fraction = clamp(Math.abs(value) / maxMagnitude, 0, 1) * 50;
  el.classList.toggle("charts-panel-bar-fill-negative", value < 0);
  el.classList.toggle("charts-panel-bar-fill-positive", value >= 0);
  el.style.width = `${fraction}%`;
  el.style.left = value < 0 ? `${50 - fraction}%` : "50%";
}

/** Build one SVG polyline `d` string per column, mapping each frame's
 * `t` linearly across `[startT, endT]` -> `[0, 100]` and its value
 * across `[min, max]` -> `[100, 0]` (SVG y grows downward, so the
 * larger value maps to the smaller y). A value that is `NaN` (an
 * unparsable field on that particular frame — see `TelemetryFrame`'s
 * own doc comment) breaks the polyline at that point (a fresh `M`
 * restarts it) rather than plotting a wrong point or crashing. */
function buildChartPoints(
  frames: TelemetryFrame[],
  columns: readonly string[],
  startT: number,
  endT: number,
  min: number,
  max: number,
): Map<string, string> {
  const span = Math.max(1, endT - startT);
  const valueSpan = max - min;
  const result = new Map<string, string>();
  for (const column of columns) {
    let d = "";
    let penDown = false;
    for (const frame of frames) {
      const value = frame.values[column];
      if (value === undefined || !Number.isFinite(value)) {
        penDown = false;
        continue;
      }
      const x = (clamp(frame.t - startT, 0, span) / span) * 100;
      const y = 100 - (clamp(value - min, 0, valueSpan) / valueSpan) * 100;
      d += `${penDown ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
      penDown = true;
    }
    result.set(column, d.trim());
  }
  return result;
}

export function ChartsPanel({ linkId }: ChartsPanelProps) {
  const header = useTelemetryHeader(linkId);
  const telemetry = useTelemetry(linkId);
  const { telemetrySubscribe } = useWsActions();
  const [mode, setMode] = useState<TelemetryMode>("OFF");
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);

  const hasHeader = header !== undefined;
  const wheelCandidate = useMemo(() => findWheelCandidate(header), [header]);

  // Re-check the chart's column selection whenever the header itself
  // changes (a fresh `thdr` can carry a completely different column
  // set, per `handleTelemetryMessage`'s header-changed reset): keep
  // every picked column the new header still has, and drop the rest --
  // a column the header lacks would silently draw nothing. Only when
  // nothing survives, default to the wheel-speed pair when present (the
  // panel's headline series), else the header's first column, so the
  // chart never opens empty when there is anything to show.
  useEffect(() => {
    if (!header) {
      setSelectedColumns([]);
      return;
    }
    setSelectedColumns((previous) => {
      const kept = previous.filter((column) => header.includes(column));
      if (kept.length > 0) {
        return kept;
      }
      return wheelCandidate ? [wheelCandidate.left, wheelCandidate.right] : header.slice(0, 1);
    });
    // wheelCandidate is derived from header, so depending on header alone
    // is sufficient and avoids re-running this reset on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  function handleModeClick(next: TelemetryMode): void {
    setMode(next);
    telemetrySubscribe(linkId, next);
  }

  function toggleColumn(name: string): void {
    setSelectedColumns((previous) => {
      if (previous.includes(name)) {
        return previous.filter((column) => column !== name);
      }
      if (previous.length >= MAX_CHART_SERIES) {
        return previous;
      }
      return [...previous, name];
    });
  }

  // --- Imperative, rAF-driven drawing (never through setState) -----
  // Refs mirror the latest render's values so the rAF callback below
  // (subscribed once per mount via the effect further down) always
  // reads current state without needing to resubscribe/re-schedule
  // whenever the header or column selection changes.
  const wheelCandidateRef = useRef(wheelCandidate);
  wheelCandidateRef.current = wheelCandidate;
  const selectedColumnsRef = useRef(selectedColumns);
  selectedColumnsRef.current = selectedColumns;

  const leftFillRef = useRef<HTMLDivElement | null>(null);
  const rightFillRef = useRef<HTMLDivElement | null>(null);
  const leftValueRef = useRef<HTMLSpanElement | null>(null);
  const rightValueRef = useRef<HTMLSpanElement | null>(null);
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const lastLabelRefs = useRef(new Map<string, HTMLSpanElement>());
  const yAxisMinRef = useRef<HTMLSpanElement | null>(null);
  const yAxisMaxRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let rafId: number | null = null;

    function drawWheelBars(): void {
      const candidate = wheelCandidateRef.current;
      if (!candidate || !leftFillRef.current || !rightFillRef.current) {
        return;
      }
      const latest = telemetry.latest;
      const leftValue = latest ? latest.values[candidate.left] : undefined;
      const rightValue = latest ? latest.values[candidate.right] : undefined;
      setBarFill(leftFillRef.current, leftValue, candidate.maxMagnitude);
      setBarFill(rightFillRef.current, rightValue, candidate.maxMagnitude);
      if (leftValueRef.current) {
        leftValueRef.current.textContent =
          leftValue === undefined ? "—" : `${formatValue(leftValue)} ${candidate.unit}`;
      }
      if (rightValueRef.current) {
        rightValueRef.current.textContent =
          rightValue === undefined ? "—" : `${formatValue(rightValue)} ${candidate.unit}`;
      }
    }

    function drawChart(): void {
      const columns = selectedColumnsRef.current;
      if (columns.length === 0) {
        return;
      }
      const frames = telemetry.snapshot();
      if (frames.length === 0) {
        return;
      }
      const latestT = frames[frames.length - 1]!.t;
      const windowFrames = frames.filter((frame) => frame.t >= latestT - CHART_WINDOW_MS);
      if (windowFrames.length === 0) {
        return;
      }

      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const frame of windowFrames) {
        for (const column of columns) {
          const value = frame.values[column];
          if (value !== undefined && Number.isFinite(value)) {
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return;
      }
      if (min === max) {
        // A flat series over the window would divide by zero below --
        // widen the domain by one unit either side so it still draws a
        // (flat) line instead of collapsing to nothing.
        min -= 1;
        max += 1;
      }

      const startT = latestT - CHART_WINDOW_MS;
      const points = buildChartPoints(windowFrames, columns, startT, latestT, min, max);
      const lastFrame = windowFrames[windowFrames.length - 1];
      for (const column of columns) {
        const path = pathRefs.current.get(column);
        if (path) {
          path.setAttribute("d", points.get(column) ?? "");
        }
        const label = lastLabelRefs.current.get(column);
        if (label && lastFrame) {
          const value = lastFrame.values[column];
          label.textContent =
            value !== undefined && Number.isFinite(value) ? `${column}: ${formatValue(value)}` : `${column}: —`;
        }
      }
      if (yAxisMinRef.current) {
        yAxisMinRef.current.textContent = formatValue(min);
      }
      if (yAxisMaxRef.current) {
        yAxisMaxRef.current.textContent = formatValue(max);
      }
    }

    function draw(): void {
      rafId = null;
      drawWheelBars();
      drawChart();
    }

    function scheduleDraw(): void {
      if (rafId === null) {
        rafId = requestAnimationFrame(draw);
      }
    }

    const unsubscribe = telemetry.subscribe(() => scheduleDraw());
    return () => {
      unsubscribe();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [telemetry]);

  return (
    <div className="charts-panel">
      <div className="charts-panel-mode" data-testid="telemetry-mode" role="group" aria-label="Telemetry stream">
        {MODES.map((candidateMode) => (
          <button
            key={candidateMode}
            type="button"
            className="charts-panel-mode-button"
            data-testid={`telemetry-mode-${candidateMode.toLowerCase()}`}
            aria-pressed={mode === candidateMode}
            onClick={() => handleModeClick(candidateMode)}
          >
            {candidateMode}
          </button>
        ))}
      </div>

      {!hasHeader && (
        <p className="charts-panel-waiting" data-testid="charts-panel-waiting" role="status">
          Waiting for the robot&rsquo;s telemetry header (thdr) — no columns known yet.
        </p>
      )}

      {hasHeader && (
        <>
          <div className="charts-panel-section">
            <h4 className="charts-panel-section-title">Wheel speed</h4>
            {wheelCandidate ? (
              <div className="charts-panel-wheel-bars" data-testid="wheel-speed-bars">
                <div className="charts-panel-wheel-bar" data-testid="wheel-speed-left">
                  <span className="charts-panel-wheel-bar-label">Left</span>
                  <div className="charts-panel-wheel-bar-track">
                    <div className="charts-panel-wheel-bar-center" />
                    <div className="charts-panel-wheel-bar-fill" ref={leftFillRef} />
                  </div>
                  <span
                    className="charts-panel-wheel-bar-value"
                    data-testid="wheel-speed-left-value"
                    ref={leftValueRef}
                  >
                    —
                  </span>
                </div>
                <div className="charts-panel-wheel-bar" data-testid="wheel-speed-right">
                  <span className="charts-panel-wheel-bar-label">Right</span>
                  <div className="charts-panel-wheel-bar-track">
                    <div className="charts-panel-wheel-bar-center" />
                    <div className="charts-panel-wheel-bar-fill" ref={rightFillRef} />
                  </div>
                  <span
                    className="charts-panel-wheel-bar-value"
                    data-testid="wheel-speed-right-value"
                    ref={rightValueRef}
                  >
                    —
                  </span>
                </div>
              </div>
            ) : (
              <p className="charts-panel-unavailable" data-testid="wheel-speed-unavailable">
                No wheel-speed columns in this header.
              </p>
            )}
          </div>

          <div className="charts-panel-section">
            <h4 className="charts-panel-section-title">Time series</h4>
            <div className="charts-panel-columns" data-testid="chart-column-picker">
              {header!.map((column) => (
                <label key={column} className="charts-panel-column-toggle">
                  <input
                    type="checkbox"
                    data-testid={`chart-column-${column}`}
                    checked={selectedColumns.includes(column)}
                    disabled={!selectedColumns.includes(column) && selectedColumns.length >= MAX_CHART_SERIES}
                    onChange={() => toggleColumn(column)}
                  />
                  {column}
                </label>
              ))}
            </div>
            {selectedColumns.length >= MAX_CHART_SERIES && (
              <p className="charts-panel-unavailable" data-testid="chart-series-cap">
                Up to {MAX_CHART_SERIES} series at once — uncheck one to add another.
              </p>
            )}

            {selectedColumns.length === 0 ? (
              <p className="charts-panel-unavailable" data-testid="chart-no-columns">
                Select at least one column to chart.
              </p>
            ) : (
              <div className="charts-panel-chart" data-testid="telemetry-chart">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="charts-panel-chart-svg"
                  role="img"
                  aria-label="Telemetry time series"
                >
                  <line x1="0" y1="25" x2="100" y2="25" className="charts-panel-chart-grid" />
                  <line x1="0" y1="50" x2="100" y2="50" className="charts-panel-chart-grid" />
                  <line x1="0" y1="75" x2="100" y2="75" className="charts-panel-chart-grid" />
                  <line x1="0" y1="100" x2="100" y2="100" className="charts-panel-chart-baseline" />
                  {selectedColumns.map((column, index) => (
                    <path
                      key={column}
                      className={`charts-panel-chart-line charts-panel-chart-${SERIES_CLASSES[index % SERIES_CLASSES.length]}`}
                      ref={(el) => {
                        if (el) {
                          pathRefs.current.set(column, el);
                        } else {
                          pathRefs.current.delete(column);
                        }
                      }}
                    />
                  ))}
                </svg>
                <div className="charts-panel-chart-axis-y">
                  <span ref={yAxisMaxRef} data-testid="chart-axis-max">
                    —
                  </span>
                  <span ref={yAxisMinRef} data-testid="chart-axis-min">
                    —
                  </span>
                </div>
                <div className="charts-panel-chart-legend" data-testid="chart-legend">
                  {selectedColumns.map((column, index) => (
                    <span
                      key={column}
                      className={`charts-panel-chart-legend-item charts-panel-chart-${SERIES_CLASSES[index % SERIES_CLASSES.length]}`}
                    >
                      <span
                        className="charts-panel-chart-legend-swatch"
                        aria-hidden="true"
                      />
                      <span
                        ref={(el) => {
                          if (el) {
                            lastLabelRefs.current.set(column, el);
                          } else {
                            lastLabelRefs.current.delete(column);
                          }
                        }}
                        data-testid={`chart-series-label-${column}`}
                      >
                        {column}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
