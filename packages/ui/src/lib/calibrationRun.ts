/**
 * calibrationRun.ts — turning a link's log into "what is this
 * calibration run doing right now".
 *
 * Both derivations were the useful half of the two wizard panels that
 * `NewCalibrationPanel` replaced on 2026-09-19. The panels went; this
 * did not, because it is where the wire's drop-tolerance lives.
 *
 * ## Drop-tolerant by construction
 *
 * Lines get dropped -- a Wi-Fi burst loses one from the middle of a
 * reply while the ack still arrives, and the radio drops about one line
 * in three. So neither derivation ever REQUIRES a particular event:
 * `.quality`/`.span`/`.ch` lines only ever add progress text, and only
 * a `.result`, a `.fail` or a bare `err` reply ends a run. A JSON line
 * belonging to a different verb (the other calibration's traffic on the
 * same link) is skipped in silence, exactly like non-JSON noise.
 *
 * A `.result` line whose fields do not validate is `unreadable`, never
 * a confident wrong number -- the distinction that keeps a garbled
 * reply from being written to a robot as a calibration.
 */
import {
  formatCalibrationEvent,
  parseCalibrationLine,
  parseTurnRestored,
  parseTurnResult,
  parseWheelsResult,
  type RestoredGeometry,
  type TurnResult,
  type WheelsResult,
} from "../components/CalibrationReport";

/** A bare `err ...` reply to the RUN itself -- the robot refusing the
 * verb, rather than a routine reporting a failure. */
const RUN_ERR_REPLY_PATTERN = /^err\b/i;

const WHEELS_VERB = "calwheels";
const TURN_VERB = "calturn";

/** The slice of a link log either derivation consumes. */
export type RunLogEntry = { direction: "tx" | "rx"; line: string };

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. */
export type WheelsCalibrationRun =
  | { kind: "running"; events: string[] }
  | { kind: "run-error"; events: string[] }
  | { kind: "unreadable"; events: string[] }
  | { kind: "failed"; events: string[]; why: string; implied?: number; lo?: number; hi?: number }
  | { kind: "succeeded"; events: string[]; result: WheelsResult };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `calibrationRun.test.ts`
 * can exercise it directly against fixture log slices.
 *
 * Drop-tolerant by construction (issue's "Lines get dropped" section):
 * this loop never requires any particular event to have arrived --
 * `.quality`/`.span` lines, if present, are rendered as progress and
 * otherwise simply never appear; only `.result`/`.fail`/a bare `err`
 * reply end the run. A JSON line belonging to a different verb (e.g.
 * `calturn`'s own traffic on the same link, or an unrelated future
 * `cal*` routine) is tolerated silently, exactly like non-JSON noise.
 */
export function deriveWheelsCalibrationRun(
  entries: readonly RunLogEntry[],
): WheelsCalibrationRun {
  let events: string[] = [];
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed) {
      if (parsed.verb !== WHEELS_VERB) {
        // Noise from a different routine's own JSON lines -- tolerated
        // silently, exactly like non-calibration noise.
        continue;
      }
      if (parsed.kind === "result") {
        const result = parseWheelsResult(parsed.fields);
        // A run that produced a `.result` line but whose fields don't
        // validate is not a success -- "couldn't read this run", never
        // a confident wrong diameter.
        return result ? { kind: "succeeded", events, result } : { kind: "unreadable", events };
      }
      if (parsed.kind === "fail") {
        // nezha-robot-template efa5a6f: a `calwheels.fail` now carries
        // `implied` -- the wheel diameter the run's own endpoints imply
        // -- plus the accepted span `lo`/`hi` in cm. That is the number
        // worth showing a student: a bad START detection once implied a
        // 778 mm wheel, which says "the field reading went wrong", not
        // "your robot is broken". Optional, and absent on older
        // firmware, so every field is read defensively.
        return {
          kind: "failed",
          events,
          why: parsed.why ?? "no reason given",
          ...(typeof parsed.fields.implied === "number" && Number.isFinite(parsed.fields.implied)
            ? { implied: parsed.fields.implied }
            : {}),
          ...(typeof parsed.fields.lo === "number" && Number.isFinite(parsed.fields.lo) ? { lo: parsed.fields.lo } : {}),
          ...(typeof parsed.fields.hi === "number" && Number.isFinite(parsed.fields.hi) ? { hi: parsed.fields.hi } : {}),
        };
      }
      events = [...events, formatCalibrationEvent(parsed.ev, parsed.fields)];
      continue;
    }
    if (RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      return { kind: "run-error", events };
    }
  }
  return { kind: "running", events };
}


/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. `restored`, when known, is carried
 * on every terminal kind (and `running`, in case it somehow raced
 * ahead) since `calturn.restored` can arrive on both the success and
 * the failure path. */
export type TurnCalibrationRun =
  | { kind: "running"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "run-error"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "unreadable"; events: string[]; restored?: RestoredGeometry | undefined }
  | { kind: "failed"; events: string[]; why: string; restored?: RestoredGeometry | undefined }
  | { kind: "succeeded"; events: string[]; result: TurnResult; restored?: RestoredGeometry | undefined };

/** Pure derivation of a run's phase from the slice of `log` recorded
 * since Go was pressed -- exported so `calibrationRun.test.ts`
 * can exercise it directly against fixture log slices.
 *
 * Drop-tolerant by construction: `.quality`/`.ch` lines, if present,
 * only ever add progress text, never gate the terminal state. Once a
 * `.result`/`.fail`/bare-`err` terminal state is reached, the loop
 * keeps consuming entries -- not to look for more terminal lines (the
 * issue's contract is exactly one `.result` or `.fail` per run), but
 * because `calturn.restored` is emitted *after* the terminal line on
 * the real wire and must still be picked up if it arrives.
 */
export function deriveTurnCalibrationRun(
  entries: readonly RunLogEntry[],
): TurnCalibrationRun {
  let events: string[] = [];
  let terminal:
    | { kind: "run-error" }
    | { kind: "unreadable" }
    | { kind: "failed"; why: string }
    | { kind: "succeeded"; result: TurnResult }
    | undefined;
  let restored: RestoredGeometry | undefined;

  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed) {
      if (parsed.verb !== TURN_VERB) {
        // Noise from a different routine's own JSON lines (e.g.
        // `calwheels` traffic on the same link) -- tolerated silently.
        continue;
      }
      if (parsed.kind === "other" && parsed.suffix === "restored") {
        // Validated best-effort: an unparsable `.restored` line is
        // simply not adopted, never surfaced as a wrong geometry.
        restored = parseTurnRestored(parsed.fields) ?? restored;
        continue;
      }
      if (terminal !== undefined) {
        // Already terminal -- a stray duplicate `.result`/`.fail`, or
        // more `.quality`/`.ch` lines, are tolerated and ignored.
        continue;
      }
      if (parsed.kind === "result") {
        const result = parseTurnResult(parsed.fields);
        terminal = result ? { kind: "succeeded", result } : { kind: "unreadable" };
        continue;
      }
      if (parsed.kind === "fail") {
        terminal = { kind: "failed", why: parsed.why ?? "no reason given" };
        continue;
      }
      events = [...events, formatCalibrationEvent(parsed.ev, parsed.fields)];
      continue;
    }
    if (terminal === undefined && RUN_ERR_REPLY_PATTERN.test(entry.line.trim())) {
      terminal = { kind: "run-error" };
    }
  }

  if (terminal === undefined) {
    return { kind: "running", events, restored };
  }
  if (terminal.kind === "run-error") {
    return { kind: "run-error", events, restored };
  }
  if (terminal.kind === "unreadable") {
    return { kind: "unreadable", events, restored };
  }
  if (terminal.kind === "failed") {
    return { kind: "failed", events, why: terminal.why, restored };
  }
  return { kind: "succeeded", events, result: terminal.result, restored };
}
