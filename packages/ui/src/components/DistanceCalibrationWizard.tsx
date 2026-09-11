/**
 * DistanceCalibrationWizard.tsx — the distance-calibration (`calx`)
 * wizard panel, mounted on `RobotPage` (ticket 003, SUC-003).
 *
 * Per `sprint.md`'s Detail-planning findings, `calx` is already fully
 * autonomous and self-reporting (creeps onto a first black line, drives
 * a known 90 cm gap, stops on a second line, and reports a corrected
 * wheel-calibration constant as plain `CALX:` text lines). This panel's
 * job is presentation and sequencing only, over capabilities `RobotPage`
 * already has -- no new host/wire work:
 *
 *  - **Availability, `FUNCS`-gated, not classification-gated** (see
 *    `sprint.md`'s Design Rationale): this panel fires its own one-shot
 *    `FUNCS` probe on mount (if a session is already open) and again on
 *    every closed->open transition, mirroring `CommandStrip`'s identical
 *    one-shot bare-`GET` pattern. Go is enabled only once `calx` appears
 *    in `device.functions`; `device.functions === undefined` (no `FUNCS`
 *    round yet) and "answered, but `calx` absent" are rendered as two
 *    distinct, calm messages -- neither is a spinner or a timeout-shaped
 *    wait.
 *  - **Running**, `RUN calx` dispatched via `sendCommand`, exactly the
 *    same call `FunctionsPanel`'s own Go button makes.
 *  - **Progress**, derived from the endpoint's own rx log
 *    (`useEndpointLog` -- the same log `CommandStrip` reads for its
 *    `GET`-reply harvesting) via `CalibrationReport.parseCalibrationLine`.
 *    Every new `rx` line appended since this panel's own Go press is
 *    replayed, in order, into one of: an opaque progress event (rendered
 *    as its own raw text -- `"begin ..."` and `"start line found"` are
 *    already visibly distinct lines, with no need for this panel to
 *    invent semantic labels for firmware text it does not otherwise
 *    interpret), the terminal `apply` event (the snippet, rendered
 *    verbatim), a `fail` event (a distinct failure state, never a
 *    snippet), or -- outside `CalibrationReport`'s own vocabulary -- a
 *    bare `err ...` reply to the `RUN` command itself (a missing/wrong
 *    program name, per `wire_handler.cpp`'s `err 1` convention),
 *    rendered as a third, distinct terminal state so it is never
 *    confused with a `CALX:fail` line or with "unavailable".
 *  - **The run's own log window is derived, not accumulated as
 *    incremental state**: `runStartIndex` records `log.length` at the
 *    moment Go was pressed, and the run's current phase is recomputed
 *    from `log.slice(runStartIndex)` on every render (`useMemo`) --
 *    mirroring `CommandStrip`'s own `discoveredNames` derivation from
 *    `log` rather than separately-mutated state, so a cleared log or a
 *    second Go press both fall out of the same derivation with no extra
 *    reset path to keep in sync.
 *
 * No nudge control, no beam-pointer UI: this routine has neither (see
 * `sprint.md`'s Detail-planning findings) -- both are out of scope for
 * this panel by design, not merely unimplemented.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { parseCalibrationLine } from "./CalibrationReport";
import { useEndpointLog, useWsActions } from "../ws/WsProvider";
import "./DistanceCalibrationWizard.css";

/** Matches a bare `err ...` reply to the `RUN` command itself (e.g.
 * `err 1 #7`, `wire_handler.cpp`'s convention for an unregistered
 * program name) -- never a `CALX:`-prefixed line, since those are
 * intercepted by {@link parseCalibrationLine} first. Loose prefix
 * match, mirroring `CommandStrip.tsx`'s own `GET_REPLY_PATTERN`
 * discipline rather than a fixed reply grammar. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment ("The run's own log window..."). */
export type DistanceCalibrationRun =
  | { kind: "running"; events: string[] }
  | { kind: "run-error"; events: string[] }
  | { kind: "succeeded"; events: string[]; snippet: string }
  | { kind: "failed"; events: string[]; reason: string };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `DistanceCalibrationWizard.test.tsx`
 * can exercise it directly against fixture log slices without mounting
 * the component, mirroring `FunctionsPanel.test.tsx`'s direct tests of
 * `parseSignature`/`positionalArgs`. */
export function deriveDistanceCalibrationRun(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): DistanceCalibrationRun {
  let events: string[] = [];
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const event = parseCalibrationLine("CALX", entry.line);
    if (event) {
      if (event.kind === "apply") {
        return { kind: "succeeded", events, snippet: event.snippet };
      }
      if (event.kind === "fail") {
        return { kind: "failed", events, reason: event.reason };
      }
      events = [...events, event.text];
      continue;
    }
    if (RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      return { kind: "run-error", events };
    }
  }
  return { kind: "running", events };
}

/**
 * OOP 2026-09-10 (stakeholder): the wizard's answer is the wheel
 * diameter, not a "calibration" number -- this routine *is* how the
 * diameter gets measured. The template's `calx` reports it directly
 * (`CALX:diameter=90.3 mm`); an older build that only sends the
 * `CALX:apply diffDrive.setWheelCalibration(<mm per degree>)` line is
 * converted (diameter = mm/deg × 360 / π). `undefined` when neither is
 * present, in which case the raw firmware snippet is shown as-is.
 */
export function deriveWheelDiameterMm(events: readonly string[], snippet: string): number | undefined {
  for (const text of events) {
    const match = /^diameter=\s*(-?\d+(?:\.\d+)?)/.exec(text.trim());
    if (match) {
      return round2(Number(match[1]));
    }
  }
  const applied = /setWheelCalibration\(\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(snippet);
  if (applied) {
    return round2((Number(applied[1]) * 360) / Math.PI);
  }
  return undefined;
}

/** The wheel diameter the robot was running with before this run, from
 * `CALX:begin ... baseline=<mm per degree>mm/deg`. */
export function deriveBaselineDiameterMm(events: readonly string[]): number | undefined {
  for (const text of events) {
    const match = /baseline=\s*(-?\d+(?:\.\d+)?)/.exec(text);
    if (match) {
      return round2((Number(match[1]) * 360) / Math.PI);
    }
  }
  return undefined;
}

/** The line a student pastes: the extension's only geometry setter
 * takes mm per shaft degree, so the diameter is written literally and
 * the conversion (π·D/360) is spelled out in the code itself rather
 * than hidden in a pre-multiplied constant. */
export function wheelDiameterSnippet(diameterMm: number): string {
  return `diffDrive.setWheelCalibration(${diameterMm} * Math.PI / 360)`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DistanceCalibrationWizardProps {
  device: EndpointListEntry;
}

export function DistanceCalibrationWizard({ device }: DistanceCalibrationWizardProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();
  const log = useEndpointLog(endpointId);
  const functions = device.functions;
  const available = functions?.some((fn) => fn.name === "calx") ?? false;

  // One-shot FUNCS probe on mount (if already open) and on every
  // closed->open transition -- see this module's doc comment;
  // identical shape to CommandStrip's bare-GET discovery effect.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = linkOpen;
    if (linkOpen && !wasOpen) {
      sendCommand(endpointId, "FUNCS");
    }
  }, [linkOpen, endpointId, sendCommand]);

  const [runStartIndex, setRunStartIndex] = useState<number | undefined>(undefined);

  const run = useMemo<DistanceCalibrationRun | undefined>(() => {
    if (runStartIndex === undefined) {
      return undefined;
    }
    return deriveDistanceCalibrationRun(log.slice(runStartIndex));
  }, [log, runStartIndex]);

  const goDisabled = !linkOpen || !available || run?.kind === "running";

  function handleGo(): void {
    if (goDisabled) {
      return;
    }
    setRunStartIndex(log.length);
    sendCommand(endpointId, "RUN", ["calx"]);
  }

  const diameterMm = run?.kind === "succeeded" ? deriveWheelDiameterMm(run.events, run.snippet) : undefined;
  const baselineMm = run?.kind === "succeeded" ? deriveBaselineDiameterMm(run.events) : undefined;
  const snippet = run?.kind === "succeeded" ? (diameterMm !== undefined ? wheelDiameterSnippet(diameterMm) : run.snippet) : "";

  function handleCopy(snippet: string): void {
    try {
      void navigator.clipboard?.writeText(snippet);
    } catch {
      // Clipboard unavailable (permissions, non-secure context, or no
      // Clipboard API at all in a test's jsdom) -- the snippet text is
      // still visible and selectable either way.
    }
  }

  return (
    <section className="distance-calibration-wizard" aria-label="Distance calibration">
      {functions === undefined && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-idle" role="status">
          Checking whether this robot supports calibration…
        </p>
      )}

      {functions !== undefined && !available && (
        <p className="distance-calibration-hint" data-testid="distance-calibration-unavailable" role="status">
          This robot doesn't support calibration yet.
        </p>
      )}

      {available && run === undefined && (
        <ol className="distance-calibration-setup" data-testid="distance-calibration-setup">
          <li>Lay two black lines 90 cm apart on the floor.</li>
          <li>Place the robot just behind the first line, facing forward, then press Go.</li>
        </ol>
      )}

      <button
        type="button"
        className="distance-calibration-go"
        data-testid="distance-calibration-go"
        disabled={goDisabled}
        onClick={handleGo}
      >
        Go
      </button>

      {run?.kind === "running" && (
        <div className="distance-calibration-progress" data-testid="distance-calibration-progress" role="status">
          <p>Running…</p>
          {run.events.length > 0 && (
            <ul>
              {run.events.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {run?.kind === "run-error" && (
        <p className="distance-calibration-run-error" data-testid="distance-calibration-run-error" role="alert">
          The robot rejected the run request — "calx" may not be registered on this build.
        </p>
      )}

      {run?.kind === "failed" && (
        <p className="distance-calibration-failed" data-testid="distance-calibration-failed" role="alert">
          Calibration failed: {run.reason}
        </p>
      )}

      {run?.kind === "succeeded" && (
        <div className="distance-calibration-result" data-testid="distance-calibration-result">
          {diameterMm !== undefined && (
            <p className="distance-calibration-diameter" data-testid="distance-calibration-diameter">
              Wheel diameter: <strong>{diameterMm} mm</strong>
              {baselineMm !== undefined && baselineMm !== diameterMm ? ` (was ${baselineMm} mm)` : ""}
            </p>
          )}
          <p>Paste this into your program's setup:</p>
          <code className="distance-calibration-snippet" data-testid="distance-calibration-snippet">
            {snippet}
          </code>
          {diameterMm !== undefined && (
            <p className="distance-calibration-note">
              The number is your wheel diameter in millimetres; the rest converts it to the
              millimetres-per-degree the extension stores.
            </p>
          )}
          <button
            type="button"
            className="distance-calibration-copy"
            data-testid="distance-calibration-copy"
            onClick={() => handleCopy(snippet)}
          >
            Copy
          </button>
        </div>
      )}
    </section>
  );
}
