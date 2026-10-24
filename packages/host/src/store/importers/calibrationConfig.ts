/**
 * calibrationConfig.ts — bootstrap-time importer: resolves
 * `ROBOT_CONSOLE_CALWHEELS_CM` (`process.env` first, then `.env`, the
 * same lookup `./firmwareConfig.ts` uses) into the
 * `calibration.wheelsTapeCm` `settings` row -- the tape-measured
 * distance the calibration page pre-fills for `calwheels`. Absent,
 * blank or not a positive number leaves the row as it was.
 */
import { WHEELS_TAPE_CM_SETTINGS_KEY } from "../../config.js";
import type { Store } from "../index.js";
import { resolveDotenvVars, type ImportFirmwareConfigDeps, type ImportFirmwareConfigOptions } from "./firmwareConfig.js";

export const CALWHEELS_CM_ENV_VAR = "ROBOT_CONSOLE_CALWHEELS_CM";

export function importCalibrationConfig(
  store: Store,
  options: ImportFirmwareConfigOptions = {},
  deps: ImportFirmwareConfigDeps = {},
): boolean {
  const env = options.env ?? process.env;
  const fromEnv = env[CALWHEELS_CM_ENV_VAR];
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : resolveDotenvVars(options, deps)[CALWHEELS_CM_ENV_VAR];
  const cm = raw === undefined || raw.trim().length === 0 ? Number.NaN : Number(raw);
  if (!Number.isFinite(cm) || cm <= 0) {
    return false;
  }
  store.setSetting(WHEELS_TAPE_CM_SETTINGS_KEY, String(cm));
  return true;
}
