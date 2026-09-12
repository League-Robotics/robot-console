/**
 * CalibrationTable.tsx — the "current calibration" two-column table
 * (wheel diameter / measured track width / effective track width /
 * rotational slip), shared by `CalibrationPage`'s own Calibration tab
 * and `ConfigurationPage`'s Configuration tab (ticket 017-008;
 * `docs/reviews/2026-09-11/04-ui.md` §4's "Calibration table" row).
 *
 * The two call sites' markup and copy are almost, but not quite,
 * identical (`CalibrationPage.tsx`'s and `ConfigurationPage.tsx`'s own
 * pre-extraction versions): only `CalibrationPage` shows the "from
 * distance calibration" / "wheel centre to wheel centre" annotations,
 * and the two pages phrase the not-yet-measured effective-track and
 * unmeasured-slip cells differently. `variant` reproduces each site's
 * exact prior text/DOM (ids, `data-testid`s, and copy) rather than
 * picking one -- a pure extraction, not a redesign, same discipline as
 * ticket 007's `RelayConnectControls` "card"/"page" variants.
 */
import { parsePositiveNumber, type CalibrationPatch, type CalibrationState, type DerivedCalibration } from "../lib/calibration";
import "./CalibrationTable.css";

export type CalibrationTableVariant = "calibration" | "configuration";

export interface CalibrationTableProps {
  variant: CalibrationTableVariant;
  state: CalibrationState;
  derived: DerivedCalibration;
  onPatch: (patch: CalibrationPatch) => void;
}

export function CalibrationTable({ variant, state, derived, onPatch }: CalibrationTableProps) {
  const idPrefix = variant;
  const tableTestId = variant === "calibration" ? "calibration-table" : "configuration-calibration";
  const effectiveTestId = `${variant}-effective-track`;
  const slipTestId = `${variant}-slip`;

  return (
    <table className="calibration-table" data-testid={tableTestId}>
      <tbody>
        <tr>
          <th scope="row">
            <label htmlFor={`${idPrefix}-wheel-diameter`}>Wheel diameter</label>
          </th>
          <td>
            <input
              id={`${idPrefix}-wheel-diameter`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="1"
              placeholder="not calibrated"
              value={state.wheelDiameterMm ?? ""}
              onChange={(event) => {
                const value = parsePositiveNumber(event.target.value);
                onPatch({ wheelDiameterMm: value, wheelDiameterSource: value === undefined ? undefined : "entered" });
              }}
            />{" "}
            mm
            {variant === "calibration" && state.wheelDiameterSource === "distance-calibration" && (
              <span className="calibration-source"> from distance calibration</span>
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">
            <label htmlFor={`${idPrefix}-track-width`}>Measured track width</label>
          </th>
          <td>
            <input
              id={`${idPrefix}-track-width`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="1"
              placeholder="optional"
              value={state.measuredTrackWidthCm ?? ""}
              onChange={(event) => onPatch({ measuredTrackWidthCm: parsePositiveNumber(event.target.value) })}
            />{" "}
            cm
            {variant === "calibration" && (
              <span className="calibration-source"> wheel centre to wheel centre, if you measured it</span>
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">Effective track width</th>
          <td data-testid={effectiveTestId}>
            {derived.effectiveTrackWidthCm !== undefined
              ? `${derived.effectiveTrackWidthCm} cm`
              : variant === "calibration"
                ? "not measured yet — run the rotation calibration"
                : "run the rotation calibration"}
          </td>
        </tr>
        <tr>
          <th scope="row">Rotational slip</th>
          <td data-testid={slipTestId}>
            {variant === "calibration"
              ? derived.rotationalSlip !== undefined
                ? state.measuredTrackWidthCm !== undefined
                  ? `${derived.rotationalSlip}`
                  : "1 (no measured track width, so the effective width is used directly)"
                : "—"
              : (derived.rotationalSlip ?? "—")}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
