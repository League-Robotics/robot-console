/**
 * CalibrationStore.ts — pure derivation of the robot's own on-board
 * calibration store (`calshow`/`calclear`, profile
 * `calibration-0.20260919.4`) from a link's rx log, mirroring
 * `DistanceCalibrationWizard.tsx`'s/`RotationCalibrationWizard.tsx`'s
 * own `deriveXCalibrationRun` pattern -- pure function over log
 * entries, exported so `CalibrationStore.test.ts` can exercise it
 * directly against fixture log slices.
 *
 * ## Why this exists, separately from the two wizards
 *
 * The use case this ticket completes: "a student runs both
 * calibrations from the robot's own A/B button menu with no computer
 * attached, carries the robot to a laptop, plugs in, and opens the
 * calibrate menu to find their numbers." That flow has no wizard `Go`
 * press at all in this browser -- `calshow` is the *only* source of
 * truth, sent on connect (see `CalibrationStorePanel.tsx`) and read
 * back here. Unlike the wizards' own derivers, this one scans the
 * *whole* log, not a window anchored at a run's start: `calshow` is a
 * request/response, not a "run" with setup/progress/terminal phases,
 * and a `calclear` fired mid-session must visibly reset what an
 * earlier `calshow` reported, which a forward scan with "last write
 * wins" gives for free.
 *
 * ## `calshow` is authoritative; the `boot cal ...` line is a hint
 *
 * A `boot cal ...` line (plain text, not JSON -- see
 * `CalibrationReport.ts`'s `parseBootCalLine` doc comment for why it is
 * parsed by a wholly separate function) is opportunistic: printed once
 * at boot, before this console is necessarily even listening. It is
 * kept as `bootHint` purely so a caller can show *something* in the
 * instant after connect and before `calshow`'s own response lines
 * arrive, never as a substitute once a real `calstore.values` shows up
 * -- callers must prefer `values` over `bootHint` whenever `values` is
 * defined, exactly as `CalibrationStorePanel.tsx` does.
 */
import {
  parseBootCalLine,
  parseCalibrationLine,
  parseCalstoreRuns,
  parseCalstoreValues,
  type BootCalHint,
  type CalstoreRuns,
  type CalstoreValues,
} from "./CalibrationReport";

const VERB = "calstore";

export interface CalStoreState {
  /** The latest `calstore.values`, or `undefined` if `calshow` has
   * never answered yet this session, its last answer's fields didn't
   * validate, or a later `calclear` reset it with no fresh `calshow`
   * response since. */
  values: CalstoreValues | undefined;
  /** The latest `calstore.runs`, same lifetime rules as `values`. */
  runs: CalstoreRuns | undefined;
  /** True when the most recent calstore-affecting event was a
   * `calstore.cleared` with no `calstore.values` response after it --
   * i.e. "we just cleared this, and haven't re-asked yet" -- so a panel
   * can show a distinct "cleared" confirmation rather than reusing the
   * generic "not calibrated yet" copy an unanswered `calshow` also
   * produces. */
  justCleared: boolean;
  /** The most recent `boot cal ...` line seen, if any -- an
   * opportunistic hint only, never authoritative once `values` is set.
   * See this module's own doc comment. */
  bootHint: BootCalHint | undefined;
}

const EMPTY_STATE: CalStoreState = { values: undefined, runs: undefined, justCleared: false, bootHint: undefined };

/**
 * Derive the current on-board calibration store state from `entries`
 * (a link's full rx/tx log, unfiltered -- only `rx` lines are read).
 * Forward scan, last-write-wins per field: a `calstore.cleared` resets
 * both `values` and `runs` to `undefined` until a fresh `calshow`
 * response supersedes it; a malformed `.values`/`.runs` line (missing
 * or non-numeric required fields) is simply not adopted, leaving
 * whatever was known before standing -- "couldn't read this one", never
 * a regression to "unknown" for data that was previously trustworthy.
 */
export function deriveCalStoreState(entries: readonly { direction: "tx" | "rx"; line: string }[]): CalStoreState {
  let values: CalstoreValues | undefined;
  let runs: CalstoreRuns | undefined;
  let justCleared = false;
  let bootHint: BootCalHint | undefined;

  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed) {
      if (parsed.verb !== VERB || parsed.kind !== "other") {
        continue;
      }
      if (parsed.suffix === "values") {
        const v = parseCalstoreValues(parsed.fields);
        if (v) {
          values = v;
          justCleared = false;
        }
      } else if (parsed.suffix === "runs") {
        const r = parseCalstoreRuns(parsed.fields);
        if (r) {
          runs = r;
        }
      } else if (parsed.suffix === "cleared") {
        values = undefined;
        runs = undefined;
        justCleared = true;
      }
      continue;
    }
    const boot = parseBootCalLine(entry.line);
    if (boot) {
      bootHint = boot;
    }
  }

  if (values === undefined && runs === undefined && !justCleared && bootHint === undefined) {
    return EMPTY_STATE;
  }
  return { values, runs, justCleared, bootHint };
}
