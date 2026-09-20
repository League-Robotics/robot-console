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
 *  - **Effective track width** comes from the rotation wizard (`calturn`
 *    as of OOP 2026-09-18; formerly `cala`/`calc`). The calibration
 *    image runs that routine against whatever wheel calibration is
 *    still actually flashed (a fresh `calwheels` result can't be
 *    applied live -- see `DistanceCalibrationWizard.tsx`'s own doc
 *    comment), so the reported width is corrected here by the ratio of
 *    the real diameter to that baseline -- see {@link correctTrackWidth}.
 *    This correction predates the current firmware and nothing in
 *    `clasi/issues/calibration-calj-calc-one-click.md` says it's no
 *    longer needed, so it is kept unchanged rather than guessed away.
 *
 * ## OOP 2026-09-18: `firmwareSlip`/`robotTrackWidthCm` supersede the old `robotReportedSlip`
 *
 * `calturn.result` now hands back `slip` (`tw / b`, already divided by
 * the firmware) and `tw` (this robot's own track width from its boot
 * record) directly -- see `RotationCalibrationWizard.tsx`'s own doc
 * comment for why `slip` is "the value to store", never
 * `slip_at_anchor`. This is a materially different, more authoritative
 * number than the old `robotReportedSlip` field it replaces (`cala`'s
 * own `derived slip=`, explicitly *not* meant to be applied -- it
 * divided a hard-coded 11.5 cm anchor unrelated to this robot). Two
 * decisions this rewrite makes about the two "slip" sources now in
 * play:
 *
 *  1. **`firmwareSlip` (from `calturn.result.slip`) is what the
 *     rotation wizard's Apply button sends** via `SET rotational_slip`
 *     -- never the locally-derived {@link DerivedCalibration.rotationalSlip}
 *     below. It is a self-consistent, per-robot number (this robot's
 *     own boot-record `tw` over this run's own measured `b`) with no
 *     manual-measurement dependency, and the issue states it in exactly
 *     those terms.
 *  2. **The local division (`measuredTrackWidthCm / effectiveTrackWidthCm`)
 *     is kept, unmerged, as the value {@link calibrationCode} pastes
 *     into a rebuilt program** when a student has typed in a
 *     caliper-measured track width -- it answers a different question
 *     ("what does *your ruler* say"), and merging it into `firmwareSlip`
 *     would blend a self-reported robot fact with a manual physical
 *     measurement, the exact "confident wrong number" this project has
 *     been burned by before (a mis-recorded physical fact silently
 *     trusted -- see the issue's "Track width provenance" section).
 *     `firmwareSlip` and `robotTrackWidthCm` are shown alongside this
 *     table's own computed values, never folded into them, mirroring
 *     this codebase's existing precedent of showing two numbers side by
 *     side rather than merging them when they answer different
 *     questions.
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
  /** Straight from `calturn.result`'s `b` field, uncorrected. */
  reportedTrackWidthCm?: number;
  reportedWithDiameterMm?: number;
  /** This robot's own track width, from `calturn.result`/`.restored`'s
   * `tw` field -- baked into its boot record at flash time. A record,
   * not a live measurement; see `CalibrationTable.tsx`'s own row for
   * the provenance note shown alongside it. */
  robotTrackWidthCm?: number;
  /** `calturn.result`'s own `slip` field (`tw / b`, already divided by
   * the firmware) -- OOP 2026-09-18, replaces the retired
   * `robotReportedSlip` (`cala`'s `derived slip=`, against a hard-coded
   * anchor, explicitly never meant to be applied). This is the value
   * the rotation wizard's Apply button sends over `SET rotational_slip`
   * -- see this module's own doc comment ("`firmwareSlip`/
   * `robotTrackWidthCm` supersede...") for why it is never merged into
   * {@link DerivedCalibration.rotationalSlip}. */
  firmwareSlip?: number;
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
/** Arithmetic mean, or `undefined` for an empty set -- never 0, which
 * would read as a real measurement of zero. */
export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * SAMPLE standard deviation (n-1), or `undefined` for fewer than two
 * values.
 *
 * Undefined rather than 0 for a single run, because 0 would claim a
 * precision nobody measured: one run has no spread, which is not the
 * same as a spread of zero. The caller renders the difference.
 *
 * n-1 and not n because these ARE samples -- a handful of runs standing
 * in for the population of every run this robot could make -- and the
 * population form biases a three-run estimate low, which is the wrong
 * direction to be wrong in when the number exists to tell a student
 * whether to trust their calibration.
 *
 * Replaces the percent-spread (hi-lo over mean) this console used to
 * show. Spread is driven entirely by the two extreme runs and grows
 * with sample size, so it got worse the more carefully somebody
 * measured.
 */
export function stdDev(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const average = mean(values)!;
  const sumSquares = values.reduce((total, value) => total + (value - average) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

export function correctTrackWidth(reportedCm: number, reportedWithDiameterMm: number, trueDiameterMm: number): number {
  return round((reportedCm * trueDiameterMm) / reportedWithDiameterMm, 2);
}

/** `calwheels.result`'s/`calstore.values`' `calib`/`wheel` field (mm per
 * shaft degree) as a diameter, mm -- the same `d = calib*360/π`
 * conversion `CalibrationPage.tsx` and this module's own doc comment
 * both already spell out inline; pulled out once so the `calshow`-fed
 * branch of {@link calibrationCode} below doesn't duplicate it a third
 * time. */
/**
 * Did this run end because somebody pressed a button on the robot,
 * rather than because it failed?
 *
 * calibration-0.20260919.5 made A / B / A+B stop a running program as a
 * safety stop -- the stakeholder's reasoning being that a student who
 * sees the robot heading for the edge of the table should not have to
 * remember which button. The firmware reports it through the ordinary
 * `<verb>.fail` event with `why: "stopped by a button press"`.
 *
 * It matters that the UI tells the two apart. A red "Calibration failed"
 * overstates what happened: nothing went wrong, a person intervened on
 * purpose. And from the console's side a button stop during a run *we*
 * launched is otherwise indistinguishable from the robot bailing, so
 * saying which it was is the difference between "your robot is broken"
 * and "somebody put their hand on it".
 *
 * Matched loosely on purpose. This project has already renamed these
 * verbs three times in a day, so an exact-string match is a poor bet;
 * anything that fails to match simply renders as an ordinary failure,
 * which is the safe direction to be wrong in.
 */
export function isButtonStop(why: string | undefined): boolean {
  return why !== undefined && /stopped by a button/i.test(why);
}

export function calibToDiameterMm(calib: number): number {
  return round((calib * 360) / Math.PI, 2);
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

/**
 * The subset of `calstore.values` (see `CalibrationReport.ts`'s own doc
 * comment) {@link calibrationCode} needs to fill in a calibration this
 * browser session never itself measured -- the "carried the robot over
 * from the A/B button menu, plugged in cold" case, which
 * `CalibrationState` alone can never cover since it only ever grows
 * from a wizard run made *in this browser*. A `CalstoreValues` object
 * satisfies this structurally (same field names) with no import needed
 * -- kept as its own local type so this pure-math module doesn't reach
 * into `components/` for it.
 */
export interface CalStoreDefaults {
  hasWheel: boolean;
  hasTurn: boolean;
  wheelCalib: number;
  trackWidthCm: number;
  slip: number;
  liveTrackWidthCm: number;
  liveSlip: number;
}

export interface CalibrationCodeOptions {
  /** The robot's own `calshow`-reported store, when known (`calshow`
   * has answered this connection). `undefined` -- not merely
   * "everything false" -- means "haven't asked yet / not connected",
   * and keeps {@link calibrationCode} to its pre-`calshow` behavior
   * (never inventing a compiled-default line the caller has no
   * evidence for). */
  calStore?: CalStoreDefaults | undefined;
  /** The connected device's own reported program string (e.g.
   * `device.program`, `"calibration-0.20260919.4"`), named in an
   * unmeasured default's comment so that comment never goes stale on
   * its own -- the same "don't hardcode a fact the firmware can tell
   * you live" reasoning the comment itself asks the *reader* to apply
   * to the number beside it. */
  firmwareProfile?: string | null | undefined;
}

/** The one block of code a student pastes into their program's setup.
 * Empty when nothing is known yet -- neither this session's own wizard
 * runs/typed entries nor (once connected) the robot's own `calshow`
 * store have anything to report. */
export function calibrationCode(state: CalibrationState, robotName: string, options?: CalibrationCodeOptions): string {
  const derived = deriveCalibration(state);
  const calStore = options?.calStore;
  const profileLabel = options?.firmwareProfile ? `${options.firmwareProfile}'s` : "the firmware's";
  const lines: string[] = [];

  // --- Wheel diameter --------------------------------------------------
  // 1. This session's own wizard run or typed entry wins outright.
  // 2. Otherwise, a value stored on the robot itself (`calshow`,
  //    `has_wheel`) -- this robot's own calibration, just not measured
  //    in this browser.
  // 3. Otherwise, once `calshow` has genuinely answered "not stored",
  //    the firmware's compiled default -- so a program that also turns
  //    still drives straight instead of silently mis-driving on a
  //    missing call the student has no way to notice. Labelled
  //    unmistakably as NOT measured: hardcoding it pins today's
  //    default, and a later firmware flash whose default differs will
  //    silently lose to this literal.
  if (state.wheelDiameterMm !== undefined) {
    lines.push(
      `diffDrive.setWheelCalibration(${state.wheelDiameterMm} * Math.PI / 360)  // wheel diameter ${state.wheelDiameterMm} mm`,
    );
  } else if (calStore?.hasWheel) {
    const diameterMm = calibToDiameterMm(calStore.wheelCalib);
    lines.push(
      `diffDrive.setWheelCalibration(${diameterMm} * Math.PI / 360)  // wheel diameter ${diameterMm} mm -- stored on the robot (calshow)`,
    );
  } else if (calStore !== undefined) {
    lines.push(
      `diffDrive.setWheelCalibration(${CALIBRATION_IMAGE_BASELINE_DIAMETER_MM} * Math.PI / 360)  // NOT measured -- ${profileLabel} compiled default. Running the wheel calibration replaces this; flashing different firmware whose default differs will silently override this hardcoded line.`,
    );
  }

  // --- Track width -------------------------------------------------------
  // Same three-tier precedence as the wheel diameter above, except tier
  // 3's number comes from `calshow`'s own `live_tw` (what the robot is
  // actually running right now) rather than a project-wide constant --
  // this robot's own track width is baked into its boot record
  // per-robot, so there is no single project-wide compiled default to
  // fall back on the way there is for the wheel.
  if (derived.trackWidthCm !== undefined) {
    const how =
      state.measuredTrackWidthCm !== undefined
        ? "measured track width, cm"
        : "effective track width, cm (not measured with a ruler)";
    lines.push(`diffDrive.setTrackWidth(${derived.trackWidthCm})  // ${how}`);
  } else if (calStore?.hasTurn) {
    lines.push(
      `diffDrive.setTrackWidth(${calStore.trackWidthCm})  // track width, cm -- stored on the robot (calshow), from an earlier rotation calibration`,
    );
  } else if (calStore !== undefined) {
    lines.push(
      `diffDrive.setTrackWidth(${calStore.liveTrackWidthCm})  // NOT measured -- ${profileLabel} compiled default, currently running. Running the rotation calibration replaces this; flashing different firmware whose default differs will silently override this hardcoded line.`,
    );
  }

  // --- Rotational slip -----------------------------------------------
  // OOP 2026-09-19, found in a browser walk: this block used
  // `derived.rotationalSlip` unconditionally, which falls back to `1`
  // when no ruler measurement exists. With a `calturn` run applied, the
  // page then showed "Applied -- rotational_slip set to 1.008" from the
  // rotation wizard while this snippet said
  // `setConfigValue(ConfigField.RotationalSlip, 1)` -- two visible,
  // contradictory answers on one screen, and the student pastes the
  // wrong one into their program, silently undoing the calibration they
  // just applied.
  //
  // Precedence, unchanged from that fix and not to be regressed:
  //  1. A ruler measurement the human deliberately typed wins -- the
  //     page advertises "typing a measured width switches to a computed
  //     slip", and nothing must silently override an explicit human
  //     measurement.
  //  2. Otherwise the firmware's own slip, when a calturn run reported
  //     one *this session*.
  //  3. Otherwise the local ruler/effective-width division's own
  //     fallback (1, from `deriveCalibration`).
  //  4. New in this ticket, both lower-priority than every session-local
  //     source above: the robot's own *stored* slip (`calshow`,
  //     `has_turn`) -- a real measurement, just not made in this
  //     browser.
  //  5. Finally, once `calshow` has answered "nothing stored", the
  //     robot's own *live* slip -- whatever it is actually running,
  //     compiled default or otherwise -- labelled as not measured.
  if (state.measuredTrackWidthCm !== undefined) {
    if (derived.rotationalSlip !== undefined) {
      lines.push(
        `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${derived.rotationalSlip})  // measured ${state.measuredTrackWidthCm} cm / effective ${derived.effectiveTrackWidthCm} cm`,
      );
    }
  } else if (state.firmwareSlip !== undefined) {
    lines.push(
      `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${state.firmwareSlip})  // from the rotation calibration${state.robotTrackWidthCm !== undefined ? ` (${state.robotTrackWidthCm} cm boot-record track width / measured turn)` : ""}`,
    );
  } else if (derived.rotationalSlip !== undefined) {
    lines.push(
      `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${derived.rotationalSlip})  // no ruler measurement, so the effective width is used as-is`,
    );
  } else if (calStore?.hasTurn) {
    lines.push(
      `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${calStore.slip})  // stored on the robot (calshow), from an earlier rotation calibration`,
    );
  } else if (calStore !== undefined) {
    lines.push(
      `diffDrive.setConfigValue(ConfigField.RotationalSlip, ${calStore.liveSlip})  // NOT measured -- ${profileLabel} compiled default, currently running`,
    );
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
