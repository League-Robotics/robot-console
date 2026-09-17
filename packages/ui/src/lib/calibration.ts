/**
 * lib/calibration.ts — the calibration state shape, its undefined-
 * stripping merge, and its derived-value/code-generation math (ticket
 * 017-008; `docs/reviews/2026-09-11/04-ui.md` §4's "Calibration table"
 * and "`patchCalibration`/`update` undefined-stripping merge" rows).
 * Moved verbatim out of `components/CalibrationPage.tsx`, this module's
 * former home, so `ConfigurationPage.tsx` (and this ticket's own
 * `components/CalibrationTable.tsx`) have one place to import it from
 * instead of reaching into a page component's module.
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
  /** The robot's own `CALA:derived slip=<n> ...` line (ticket 018-013) --
   * the firmware's own slip computation, against its hard-coded 11.5 cm
   * anchor (see `RotationCalibrationWizard.tsx`'s own `robotReportedSlip`
   * doc comment for why this is never folded into {@link
   * DerivedCalibration.rotationalSlip}: the image's own anchor has
   * nothing to do with this robot's measured width). Shown alongside our
   * own derived slip in the "Current calibration" table, never in place
   * of it. */
  robotReportedSlip?: number;
}

/** A patch to `CalibrationState` -- any field set to `undefined` is
 * stripped by {@link applyCalibrationPatch} rather than stored as an
 * explicit `undefined` key. */
export type CalibrationPatch = { [K in keyof CalibrationState]?: CalibrationState[K] | undefined };

/**
 * Merge `patch` into `previous`, then delete any key whose value came
 * out `undefined` -- so clearing a field (e.g. the user blanks the
 * wheel-diameter input) removes it from the state rather than leaving
 * an explicit `undefined` that `JSON.stringify`/`readCalibrationState`
 * would round-trip inconsistently. The one merge both `CalibrationPage`
 * and `ConfigurationPage` used to duplicate (`04-ui.md` §4).
 */
export function applyCalibrationPatch(previous: CalibrationState, patch: CalibrationPatch): CalibrationState {
  const merged: Record<string, unknown> = { ...previous, ...patch };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged as CalibrationState;
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
