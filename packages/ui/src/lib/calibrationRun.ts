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
 *
 * ## A lost terminal line
 *
 * Over Wi-Fi the robot can drop several seconds of output at once,
 * `.result` included. The panel queues a `RUN _calshow` behind every
 * calibration RUN; the robot runs one job at a time, so its `calstore`
 * reply only comes once the calibration has finished. A `calstore.runs`
 * line that arrives after the run started, with no terminal line before
 * it, means the result was lost. A run whose stored count went up is
 * `recovered` -- a wheel from the stored value, a turn's `b` from
 * `calturn.stored`'s `run` or from the begin line's anchor `b` times
 * `calturn.quality`'s gap/sector, which is how the robot computes it.
 * Anything else is `lost`.
 */
import {
  formatCalibrationEvent,
  parseCalibrationLine,
  parseCalstoreRuns,
  parseCalstoreValues,
  type CalibrationEvent,
  type CalstoreRuns,
  type CalstoreValues,
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

/** What the robot's `calshow` said before the run was sent. */
export interface StoreBefore {
  values?: CalstoreValues | undefined;
  runs?: CalstoreRuns | undefined;
}

/** Tracks whether `verb`'s run has visibly started, so a `calstore` reply
 * to a `_calshow` sent BEFORE the run is never read as the end of it:
 * the robot answers in order, so anything after the RUN's ack or the
 * run's own output is from after the run. */
function startTracker(verb: string): (entry: RunLogEntry, parsed: CalibrationEvent | undefined) => boolean {
  let runId: string | undefined;
  let started = false;
  const textPrefix = `${verb.toUpperCase()}:`;
  return (entry, parsed) => {
    if (started) return true;
    const line = entry.line.trim();
    if (entry.direction === "tx") {
      const match = new RegExp(`^RUN ${verb}\\b.*#(\\d+)$`).exec(line);
      if (match) runId = match[1];
      return false;
    }
    started =
      parsed?.verb === verb || line.startsWith(textPrefix) || (runId !== undefined && line.startsWith(`ack ${runId} `));
    return started;
  };
}

/** A `calstore.values`/`.runs` line, read; `undefined` for anything else. */
function readCalstore(parsed: CalibrationEvent | undefined): { values?: CalstoreValues; runs?: CalstoreRuns } | undefined {
  if (parsed?.verb !== "calstore" || parsed.kind !== "other") return undefined;
  if (parsed.suffix === "values") {
    const values = parseCalstoreValues(parsed.fields);
    return values ? { values } : {};
  }
  if (parsed.suffix === "runs") {
    const runs = parseCalstoreRuns(parsed.fields);
    return runs ? { runs } : {};
  }
  return undefined;
}

/** One calibration run's current phase, derived from the endpoint's log
 * -- see this module's doc comment. */
export type WheelsCalibrationRun =
  | { kind: "running"; events: string[] }
  | { kind: "run-error"; events: string[] }
  | { kind: "unreadable"; events: string[] }
  | { kind: "failed"; events: string[]; why: string; implied?: number; lo?: number; hi?: number }
  | { kind: "succeeded"; events: string[]; result: WheelsResult }
  | { kind: "recovered"; events: string[]; calib: number; wasCalib: number }
  | { kind: "lost"; events: string[] };

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
  before: StoreBefore = {},
): WheelsCalibrationRun {
  let events: string[] = [];
  const hasStarted = startTracker(WHEELS_VERB);
  let storedValues: CalstoreValues | undefined;
  for (const entry of entries) {
    const parsed = entry.direction === "rx" ? parseCalibrationLine(entry.line) : undefined;
    const started = hasStarted(entry, parsed);
    if (entry.direction !== "rx") {
      continue;
    }
    const store = started ? readCalstore(parsed) : undefined;
    if (store?.values) storedValues = store.values;
    if (store?.runs) {
      const ranBefore = before.runs?.wheelRuns;
      if (ranBefore === undefined || store.runs.wheelRuns <= ranBefore || !storedValues) {
        return { kind: "lost", events };
      }
      const wasCalib = before.values?.hasWheel ? before.values.wheelCalib : storedValues.wheelCalib;
      return { kind: "recovered", events, calib: storedValues.wheelCalib, wasCalib };
    }
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
  | { kind: "succeeded"; events: string[]; result: TurnResult; restored?: RestoredGeometry | undefined }
  | { kind: "recovered"; events: string[]; result: TurnResult; restored?: RestoredGeometry | undefined }
  | { kind: "lost"; events: string[]; restored?: RestoredGeometry | undefined };

const TURN_ANCHOR_B_PATTERN = /^CALTURN:begin\b.*\banchor b=([\d.]+)cm/;

/** Positive and finite, or `undefined`. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

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
  before: StoreBefore = {},
): TurnCalibrationRun {
  let events: string[] = [];
  let terminal:
    | { kind: "run-error" }
    | { kind: "unreadable" }
    | { kind: "failed"; why: string }
    | { kind: "succeeded"; result: TurnResult }
    | undefined;
  let restored: RestoredGeometry | undefined;
  const hasStarted = startTracker(TURN_VERB);
  let anchorB: number | undefined;
  let gapPerSector: number | undefined;
  let runSlip: number | undefined;
  let storedTrackWidth: number | undefined;

  for (const entry of entries) {
    const parsed = entry.direction === "rx" ? parseCalibrationLine(entry.line) : undefined;
    const started = hasStarted(entry, parsed);
    if (entry.direction !== "rx") {
      continue;
    }
    const anchorMatch = TURN_ANCHOR_B_PATTERN.exec(entry.line.trim());
    if (anchorMatch) anchorB = positive(Number(anchorMatch[1]));
    const store = terminal === undefined && started ? readCalstore(parsed) : undefined;
    if (store?.values) storedTrackWidth = positive(store.values.trackWidthCm);
    if (store?.runs) {
      const ranBefore = before.runs?.turnRuns;
      const trackWidthCm = restored?.trackWidthCm ?? storedTrackWidth;
      const b =
        runSlip !== undefined && trackWidthCm !== undefined
          ? trackWidthCm / runSlip
          : anchorB !== undefined && gapPerSector !== undefined
            ? anchorB * gapPerSector
            : undefined;
      if (ranBefore === undefined || store.runs.turnRuns <= ranBefore || b === undefined || trackWidthCm === undefined) {
        return { kind: "lost", events, restored };
      }
      const result = { b: round3(b), trackWidthCm, slip: round4(trackWidthCm / b) };
      return { kind: "recovered", events, result, restored };
    }
    if (parsed?.verb === TURN_VERB && parsed.kind === "other") {
      if (parsed.suffix === "stored") runSlip = positive(parsed.fields.run) ?? runSlip;
      if (parsed.suffix === "quality") {
        const gap = positive(parsed.fields.gap);
        const sector = positive(parsed.fields.sector);
        if (gap !== undefined && sector !== undefined) gapPerSector = gap / sector;
      }
    }
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

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;
