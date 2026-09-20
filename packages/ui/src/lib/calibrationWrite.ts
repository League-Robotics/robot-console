/**
 * calibrationWrite.ts — the three calibration values that can now be
 * SET over the wire, and the one place that turns this console's own
 * units into the firmware's.
 *
 * ## Why this file exists as of 2026-09-19
 *
 * Until nezha-diffdrive added `wheel_diameter` (ordinal 40) and
 * `track_width` (41), `rotational_slip` (16) was the only leg of a
 * robot's calibration a bench could write. That is why
 * `RotationCalibrationWizard` has an Apply button and
 * `DistanceCalibrationWizard` deliberately had none: the asymmetry was
 * in the hardware, not in the UI. It is gone, and the three values now
 * move over the wire together.
 *
 * ## THE UNIT TRAP, which is the actual reason this is a module and not
 * three inline `sendCommand` calls
 *
 * This console stores track width in CENTIMETRES (`CalibrationState`'s
 * own `measuredTrackWidthCm`/`robotTrackWidthCm`, and the `cm` the
 * `diffDrive.setTrackWidth(12.85)` code line is pasted with, because
 * the *block* API takes cm). The wire field takes MILLIMETRES, matching
 * MotionEngine's own storage and every other length in the firmware's
 * config table.
 *
 * So the block API and the wire field disagree by 10x on the same
 * quantity, and nothing in either protocol catches it: `SET track_width
 * 12.85` is a perfectly legal write of a 1.3 cm robot, and the failure
 * it produces on the field is a robot that turns about a tenth as far
 * as it was told -- which reads as a broken gyro, or a dead motor, or
 * anything except a units bug. The conversion happens HERE, once, with
 * a test pinning it, and `CALIBRATION_WIRE_FIELDS` carries each field's
 * unit so a caller cannot quietly reach past it.
 *
 * Wheel diameter needs no conversion (mm both sides) and slip is
 * dimensionless, but both go through the same builder so that
 * "everything the robot is calibrated by" is one list with one writer.
 */
import type { WireField } from "@robot-console/protocol";
import type { CalibrationState, DerivedCalibration } from "./calibration";
import { deriveCalibration, round } from "./calibration";

/** A minimal `sendCommand`-shaped function -- matches
 * `useWsActions().sendCommand`'s own signature without importing
 * `WsProvider` here, exactly as `estop.ts` does. */
export type SendCommand = (linkId: string, verb: string, fields?: WireField[]) => void;

/**
 * The wire names, in the order a write sends them, with the unit each
 * one is in ON THE WIRE -- not the unit this console displays. See this
 * module's own doc comment on the 10x track-width trap.
 *
 * Order is deliberate: wheel diameter first, because slip and track
 * width describe a turn made on a particular wheel, so a robot that
 * takes only the first write is left consistent rather than
 * half-converted.
 */
export const CALIBRATION_WIRE_FIELDS = [
  { key: "wheelDiameter", name: "wheel_diameter", unit: "mm" },
  { key: "trackWidth", name: "track_width", unit: "mm" },
  { key: "rotationalSlip", name: "rotational_slip", unit: "1" },
] as const;

export type CalibrationFieldKey = (typeof CALIBRATION_WIRE_FIELDS)[number]["key"];

export interface CalibrationWrite {
  /** The wire key, exactly as `SET`/`GET` spell it. */
  name: string;
  /** The value in the WIRE's unit, already converted and rounded. */
  value: number;
  unit: string;
  key: CalibrationFieldKey;
}

/** cm -> mm, rounded to 3 decimals.
 *
 * The rounding is not cosmetic. `12.85 * 10` is `128.49999999999997` in
 * IEEE 754, and `String()` of that is what would go out on the wire --
 * legal, and the firmware's own `lround(x * 1000)` recovers 128500
 * either way, but it puts seventeen digits of float noise in a field a
 * human reads back with `GET` and in every log line that carries it. */
function cmToMm(cm: number): number {
  return round(cm * 10, 3);
}

/**
 * The `SET`s that would push this console's current calibration to the
 * robot. Values this session has nothing for are simply absent from the
 * list -- a partial calibration writes the part it has rather than
 * refusing or, worse, sending a zero that the firmware's own ">0, else
 * keep" guards would silently drop.
 *
 * `firmwareSlip` (straight from `calturn.result`, the robot's own
 * measurement) beats the console's derived slip, matching what
 * `RotationCalibrationWizard`'s Apply button has always sent.
 */
export function buildCalibrationWrites(
  state: CalibrationState,
  derived: DerivedCalibration = deriveCalibration(state),
): CalibrationWrite[] {
  const writes: CalibrationWrite[] = [];
  const push = (key: CalibrationFieldKey, value: number | undefined): void => {
    const field = CALIBRATION_WIRE_FIELDS.find((candidate) => candidate.key === key);
    // A non-finite or non-positive value is dropped rather than sent:
    // all three fields are guarded ">0, else keep" in the firmware, so
    // sending one would be a wire round trip that reports success and
    // changes nothing -- the most confusing possible outcome for
    // somebody watching the console to see whether a value took.
    if (!field || value === undefined || !Number.isFinite(value) || value <= 0) return;
    writes.push({ key, name: field.name, value, unit: field.unit });
  };
  push("wheelDiameter", state.wheelDiameterMm);
  const trackWidthCm = derived.trackWidthCm;
  push("trackWidth", trackWidthCm === undefined ? undefined : cmToMm(trackWidthCm));
  push("rotationalSlip", state.firmwareSlip ?? derived.rotationalSlip);
  return writes;
}

/** The store verb `writeCalibration` follows its `SET`s with. */
export const PERSIST_VERB = "calsave";

/**
 * Send the writes, in list order, as sequenced `SET`s, and then persist
 * them with `RUN calsave`. Returns the writes actually sent so a caller
 * can say which values it claimed -- a caller that reports "applied"
 * from its own draft rather than from this return value will eventually
 * claim a field it skipped.
 *
 * ## Why both, and not just the SETs
 *
 * A `SET` reaches the robot's motion engine and stops there. Nothing on
 * that path touches flash, and the robot's own `calApplyStored()` puts
 * the STORED calibration back at the next boot -- so a value written
 * here would last exactly until somebody switched the robot off, then
 * silently revert. "It worked yesterday and today it drives wrong" is
 * about the worst outcome this panel could produce, because nothing
 * about it looks like a settings problem.
 *
 * `RUN calsave <wheelMm> <trackCm> <slip>` (calstore.ts) applies AND
 * stores, on the robot, in one call. Sending both means a robot running
 * firmware with only one of the two still gets that one: older firmware
 * without the config fields still persists via calsave, and firmware
 * without calsave still takes the live SETs.
 *
 * calsave's arguments are POSITIONAL and its zero means "leave this one
 * alone" -- the same ">0, else keep" rule the firmware's own config
 * guards use -- so a skipped value goes out as 0 rather than shifting
 * the ones after it.
 */
export function writeCalibration(
  sendCommand: SendCommand,
  linkId: string,
  writes: CalibrationWrite[],
): CalibrationWrite[] {
  for (const write of writes) {
    sendCommand(linkId, "SET", [write.name, String(write.value)]);
  }
  if (writes.length > 0) {
    const of = (key: CalibrationFieldKey): string => {
      const write = writes.find((candidate) => candidate.key === key);
      return write ? String(write.value) : "0";
    };
    // calsave takes the track width in CENTIMETRES -- it is a program on
    // the robot calling diffDrive.setTrackWidth(), whose unit is cm --
    // while the `track_width` SET above takes millimetres. The two
    // disagree about the same quantity by 10x, which is the whole reason
    // this module exists; `trackWidthCm` is read back from the wire
    // value rather than re-derived, so there is one conversion and not
    // two that can drift apart.
    const trackWidthMm = writes.find((write) => write.key === "trackWidth");
    const trackWidthCm = trackWidthMm ? String(round(trackWidthMm.value / 10, 4)) : "0";
    sendCommand(linkId, "RUN", [PERSIST_VERB, of("wheelDiameter"), trackWidthCm, of("rotationalSlip")]);
  }
  return writes;
}

/** One-line summary for a status line: `wheel_diameter 81.45 mm,
 * track_width 128.5 mm, rotational_slip 1.101`. Empty string when
 * nothing was written, so a caller renders nothing rather than a
 * dangling "Applied —". */
export function describeCalibrationWrites(writes: CalibrationWrite[]): string {
  return writes
    .map((write) => `${write.name} ${write.value}${write.unit === "1" ? "" : ` ${write.unit}`}`)
    .join(", ");
}
