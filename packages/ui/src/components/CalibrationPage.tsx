/**
 * CalibrationPage.tsx — the robot page's Calibration tab (OOP
 * 2026-09-10, stakeholder direction).
 *
 * One calibration *state* per robot (persisted per robot name in
 * localStorage), one block of code to paste, and the two wizards
 * feeding that state:
 *
 *  - **Wheel diameter** comes from the distance wizard (`calx`), or is
 *    typed in. Nothing else works without it: the rotation run measures
 *    turns through wheel travel, so its answer is only right once the
 *    wheel diameter is.
 *  - **Measured track width** is optional -- typed in if the student
 *    measured it with a ruler. Without it, the rotation run's effective
 *    track width *is* the track width and the rotational slip is 1.
 *    With it, the slip is measured ÷ effective.
 *  - **Effective track width** comes from the rotation wizard (`cala`).
 *    The calibration image runs that routine with its own compiled
 *    wheel calibration (0.7878 mm/deg, a 90.28 mm wheel), never the
 *    diameter just measured, so the reported width is corrected here by
 *    the ratio of the real diameter to that baseline -- see
 *    {@link correctTrackWidth}. The image's own `derived slip` is
 *    ignored: it divides a hard-coded 11.5 cm anchor, not this robot's
 *    measured width.
 */
import { useEffect, useMemo, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "./DeviceConsole";
import {
  DistanceCalibrationWizard,
  deriveBaselineDiameterMm,
  deriveWheelDiameterMm,
  type DistanceCalibrationRun,
} from "./DistanceCalibrationWizard";
import { RotationCalibrationWizard, reportedTrackWidthCm, type RotationCalibrationRun } from "./RotationCalibrationWizard";
import "./CalibrationPage.css";

/** The compiled wheel calibration the calibration image runs `cala`
 * with (motion_engine.h's default, 0.7878 mm/deg), as a diameter. */
export const CALIBRATION_IMAGE_BASELINE_DIAMETER_MM = 90.28;

export interface CalibrationState {
  wheelDiameterMm?: number;
  wheelDiameterSource?: "distance-calibration" | "entered";
  /** The wheel diameter the robot was actually running with when the
   * rotation run was made -- what its reported width must be corrected
   * from. */
  measuredTrackWidthCm?: number;
  /** Straight from the robot's `measured b=` line, uncorrected. */
  reportedTrackWidthCm?: number;
  reportedWithDiameterMm?: number;
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The rotation routine spins by wheel travel: with the true wheel
 * bigger than the one it assumed by a factor k, every commanded turn
 * comes out k times larger and the routine concludes the track is
 * k times *narrower* than it really is. So the real effective width is
 * the reported one times k. */
export function correctTrackWidth(reportedCm: number, reportedWithDiameterMm: number, trueDiameterMm: number): number {
  return round((reportedCm * trueDiameterMm) / reportedWithDiameterMm, 2);
}

export interface DerivedCalibration {
  effectiveTrackWidthCm?: number;
  trackWidthCm?: number;
  rotationalSlip?: number;
}

export function deriveCalibration(state: CalibrationState): DerivedCalibration {
  const out: DerivedCalibration = {};
  if (state.reportedTrackWidthCm !== undefined && state.wheelDiameterMm !== undefined) {
    out.effectiveTrackWidthCm = correctTrackWidth(
      state.reportedTrackWidthCm,
      state.reportedWithDiameterMm ?? CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
      state.wheelDiameterMm,
    );
  }
  if (state.measuredTrackWidthCm !== undefined) {
    out.trackWidthCm = state.measuredTrackWidthCm;
    if (out.effectiveTrackWidthCm !== undefined && out.effectiveTrackWidthCm > 0) {
      out.rotationalSlip = round(state.measuredTrackWidthCm / out.effectiveTrackWidthCm, 3);
    }
  } else if (out.effectiveTrackWidthCm !== undefined) {
    out.trackWidthCm = out.effectiveTrackWidthCm;
    out.rotationalSlip = 1;
  }
  return out;
}

/** The one block of code a student pastes into their program's setup.
 * Empty when nothing is known yet. */
export function calibrationCode(state: CalibrationState, robotName: string): string {
  const derived = deriveCalibration(state);
  const lines: string[] = [];
  if (state.wheelDiameterMm !== undefined) {
    lines.push(
      `diffDrive.setWheelCalibration(${state.wheelDiameterMm} * Math.PI / 360)  // wheel diameter ${state.wheelDiameterMm} mm`,
    );
  }
  if (derived.trackWidthCm !== undefined) {
    const how =
      state.measuredTrackWidthCm !== undefined
        ? "measured track width, cm"
        : "effective track width, cm (not measured with a ruler)";
    lines.push(`diffDrive.setTrackWidth(${derived.trackWidthCm})  // ${how}`);
  }
  if (derived.rotationalSlip !== undefined) {
    const how =
      state.measuredTrackWidthCm !== undefined
        ? `measured ${state.measuredTrackWidthCm} cm / effective ${derived.effectiveTrackWidthCm} cm`
        : "no ruler measurement, so the effective width is used as-is";
    lines.push(`diffDrive.setConfigValue(ConfigField.RotationalSlip, ${derived.rotationalSlip})  // ${how}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return [`// ${robotName} calibration`, ...lines].join("\n");
}

function storageKey(name: string): string {
  return `robot-console:calibration:${name}`;
}

export function readCalibrationState(name: string): CalibrationState {
  try {
    const raw = window.localStorage.getItem(storageKey(name));
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as CalibrationState) : {};
  } catch {
    return {};
  }
}

export function writeCalibrationState(name: string, state: CalibrationState): void {
  try {
    window.localStorage.setItem(storageKey(name), JSON.stringify(state));
  } catch {
    // Best effort -- the page still works for this session.
  }
}

export function parsePositiveNumber(raw: string): number | undefined {
  if (raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface CalibrationPageProps {
  device: EndpointListEntry;
}

export function CalibrationPage({ device }: CalibrationPageProps) {
  const robotName = device.name ?? device.endpointId;
  const [state, setState] = useState<CalibrationState>(() => readCalibrationState(robotName));
  useEffect(() => {
    writeCalibrationState(robotName, state);
  }, [robotName, state]);

  const derived = useMemo(() => deriveCalibration(state), [state]);
  const code = useMemo(() => calibrationCode(state, robotName), [state, robotName]);
  const [copied, setCopied] = useState(false);

  type CalibrationPatch = { [K in keyof CalibrationState]?: CalibrationState[K] | undefined };
  function update(patch: CalibrationPatch): void {
    setState((previous) => {
      const merged: Record<string, unknown> = { ...previous, ...patch };
      for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) {
          delete merged[key];
        }
      }
      return merged as CalibrationState;
    });
  }

  function handleDistanceRun(run: DistanceCalibrationRun | undefined): void {
    if (run?.kind !== "succeeded") {
      return;
    }
    const diameter = deriveWheelDiameterMm(run.events, run.snippet);
    if (diameter === undefined) {
      return;
    }
    update({ wheelDiameterMm: diameter, wheelDiameterSource: "distance-calibration" });
    // A rotation result made with an older diameter is now stale.
    const baseline = deriveBaselineDiameterMm(run.events);
    if (baseline !== undefined && state.reportedWithDiameterMm === undefined) {
      update({ reportedWithDiameterMm: baseline });
    }
  }

  function handleRotationRun(run: RotationCalibrationRun | undefined): void {
    if (run?.kind === "succeeded") {
      const reported = reportedTrackWidthCm(run);
      if (reported !== undefined) {
        update({ reportedTrackWidthCm: reported, reportedWithDiameterMm: CALIBRATION_IMAGE_BASELINE_DIAMETER_MM });
      }
      return;
    }
    if (run?.kind === "failed") {
      // A failed re-verification must not leave a width standing.
      update({ reportedTrackWidthCm: undefined });
    }
  }

  function handleCopy(): void {
    try {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable -- the text is selectable either way.
    }
  }

  const rotationBlocked = state.wheelDiameterMm === undefined;

  return (
    <div className="robot-page-columns calibration-page" data-testid="robot-tab-panel-calibration">
      <div className="robot-page-column robot-page-column-left">
        <div className="robot-page-panel" aria-label="Distance calibration">
          <h3>Distance calibration</h3>
          <DistanceCalibrationWizard device={device} onRun={handleDistanceRun} />
        </div>

        <div className="robot-page-panel" aria-label="Rotation calibration">
          <h3>Rotation calibration</h3>
          <RotationCalibrationWizard
            device={device}
            onRun={handleRotationRun}
            disabled={rotationBlocked}
            disabledReason="Run the distance calibration first — the rotation run needs the wheel diameter."
          />
        </div>

        <div className="robot-page-panel calibration-code-panel" aria-label="Calibration code">
          <h3>Code for your program</h3>
          {code === "" ? (
            <p className="calibration-code-empty" data-testid="calibration-code-empty">
              Nothing to paste yet — run the distance calibration to get started.
            </p>
          ) : (
            <>
              <pre className="calibration-code" data-testid="calibration-code">
                {code}
              </pre>
              <button type="button" className="calibration-code-copy" data-testid="calibration-code-copy" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="robot-page-column robot-page-column-right">
        <div className="robot-page-panel" aria-label="Current calibration">
          <h3>Current calibration</h3>
          <table className="calibration-table" data-testid="calibration-table">
            <tbody>
              <tr>
                <th scope="row">
                  <label htmlFor="calibration-wheel-diameter">Wheel diameter</label>
                </th>
                <td>
                  <input
                    id="calibration-wheel-diameter"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    placeholder="not calibrated"
                    value={state.wheelDiameterMm ?? ""}
                    onChange={(event) => {
                      const value = parsePositiveNumber(event.target.value);
                      update({ wheelDiameterMm: value, wheelDiameterSource: value === undefined ? undefined : "entered" });
                    }}
                  />{" "}
                  mm
                  {state.wheelDiameterSource === "distance-calibration" && (
                    <span className="calibration-source"> from distance calibration</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <label htmlFor="calibration-track-width">Measured track width</label>
                </th>
                <td>
                  <input
                    id="calibration-track-width"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    placeholder="optional"
                    value={state.measuredTrackWidthCm ?? ""}
                    onChange={(event) => update({ measuredTrackWidthCm: parsePositiveNumber(event.target.value) })}
                  />{" "}
                  cm
                  <span className="calibration-source"> wheel centre to wheel centre, if you measured it</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Effective track width</th>
                <td data-testid="calibration-effective-track">
                  {derived.effectiveTrackWidthCm !== undefined
                    ? `${derived.effectiveTrackWidthCm} cm`
                    : "not measured yet — run the rotation calibration"}
                </td>
              </tr>
              <tr>
                <th scope="row">Rotational slip</th>
                <td data-testid="calibration-slip">
                  {derived.rotationalSlip !== undefined
                    ? state.measuredTrackWidthCm !== undefined
                      ? `${derived.rotationalSlip}`
                      : "1 (no measured track width, so the effective width is used directly)"
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
          <button
            type="button"
            className="calibration-reset"
            data-testid="calibration-reset"
            onClick={() => setState({})}
            disabled={Object.keys(state).length === 0}
          >
            Start over
          </button>
        </div>

        <DeviceConsole device={device} />
      </div>
    </div>
  );
}
