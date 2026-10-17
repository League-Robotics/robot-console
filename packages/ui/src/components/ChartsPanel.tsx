/**
 * ChartsPanel.tsx — the telemetry stream control (OFF/POSE/FULL), the
 * column picker and a rolling time-series chart, fed by
 * `useTelemetry`/`useTelemetryHeader` (sprint 9 ticket 004 / SUC-001).
 * The wheel-speed bars this panel used to carry were dropped
 * (2026-10-17, stakeholder direction).
 *
 * **Schemaless by construction.** `thdr` is decoded host-side with no
 * fixed column table (`packages/protocol/src/v6/telemetry.ts`), so this
 * panel looks up every column by name in whatever header the current
 * robot actually sent, and renders an explicit "waiting for header"
 * state rather than guessing when there is none.
 *
 * **No per-frame React state.** `useTelemetry`'s ring can receive tens
 * of frames a second; a single effect subscribes once and schedules a
 * `requestAnimationFrame` draw only when a frame has arrived since the
 * last draw. The draw writes directly to DOM nodes held in refs (an SVG
 * path's `d`, label text) — never through `setState`. `header`/mode/
 * column selection ARE ordinary React state, since they change at human
 * speed.
 *
 * **Subscribe control does not auto-subscribe.** Mode starts `"OFF"`;
 * nothing is sent to the robot until a person presses POSE or FULL.
 *
 * **Time-series axis stays single.** All selected columns share one
 * linear y-scale computed from their own window of values — the dataviz
 * skill's "one axis, never two y-scales" rule.
 *
 * **Color, per the `dataviz` skill's reference palette:** selected
 * columns take the categorical palette's slots in selection order,
 * never cycled. A legend and direct series labels are shown, so
 * identity never rests on color alone.
 */
import { useEffect, useRef, useState } from "react";
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
 * but has no button here. */
const MODES: readonly TelemetryMode[] = ["OFF", "POSE", "FULL"];

/** The columns charted when nothing else is picked, if the header has
 * them (this repo's firmware emits `vl`/`vr` wheel speeds in mm/s). */
const DEFAULT_COLUMNS = ["vl", "vr"] as const;

/** How much history the time-series chart shows, regardless of how much
 * the ring itself retains (`TELEMETRY_RING_CAPACITY`, ~60s). */
const CHART_WINDOW_MS = 15_000;

/** Categorical palette slot cap for the time-series chart. */
const MAX_CHART_SERIES = 4;

const SERIES_CLASSES = ["series-1", "series-2", "series-3", "series-4"] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatValue(value: number): string {
  return Number.isFinite(value) ? value.toFixed(0) : "—";
}

/** Build one SVG polyline `d` string per column, mapping each frame's
 * `t` linearly across `[startT, endT]` -> `[0, 100]` and its value
 * across `[min, max]` -> `[100, 0]`. A `NaN` value breaks the polyline
 * at that point rather than plotting a wrong point. */
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

  // Re-check the selection whenever the header changes: keep every
  // picked column the new header still has. Only when nothing survives,
  // default to the wheel-speed pair when present, else the first column.
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
      const defaults = DEFAULT_COLUMNS.filter((column) => header.includes(column));
      return defaults.length > 0 ? defaults : header.slice(0, 1);
    });
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

  const selectedColumnsRef = useRef(selectedColumns);
  selectedColumnsRef.current = selectedColumns;

  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const lastLabelRefs = useRef(new Map<string, HTMLSpanElement>());
  const yAxisMinRef = useRef<HTMLSpanElement | null>(null);
  const yAxisMaxRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let rafId: number | null = null;

    function draw(): void {
      rafId = null;
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
      <div className="charts-panel-controls">
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
        )}
      </div>

      {hasHeader && selectedColumns.length >= MAX_CHART_SERIES && (
        <p className="charts-panel-unavailable" data-testid="chart-series-cap">
          Up to {MAX_CHART_SERIES} series at once — uncheck one to add another.
        </p>
      )}

      {hasHeader && selectedColumns.length === 0 && (
        <p className="charts-panel-unavailable" data-testid="chart-no-columns">
          Select at least one column to chart.
        </p>
      )}

      {hasHeader && selectedColumns.length > 0 && (
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
                <span className="charts-panel-chart-legend-swatch" aria-hidden="true" />
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
  );
}
