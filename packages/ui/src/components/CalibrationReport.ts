/**
 * CalibrationReport.ts — a shared, pure parser for the calibration
 * routines' JSON-lines reports (OOP 2026-09-18, stakeholder: "get the
 * calibration page working" with current firmware).
 *
 * ## Third naming generation in one project
 *
 * `calx`/`cala` (prefixed prose: `CALX:.../CALA:...`) were replaced by
 * `calj`/`calc` (JSON lines), which were themselves renamed to
 * `calwheels`/`calturn` about an hour later — three verb generations in
 * one day, per `clasi/issues/calibration-calj-calc-one-click.md`. The
 * one thing that survived every rename is the *shape*: one JSON object
 * per line, `{"ev":"<verb>.<suffix>", ...fields}`, where a run ends in
 * exactly one of `<verb>.result` or `<verb>.fail` and every other
 * `<verb>.<suffix>` (`.quality`, `.span`, `.ch`, `.restored`, ...) is a
 * non-terminal, best-effort progress event.
 *
 * This module therefore keys `parseCalibrationLine` off that shape --
 * the `.result`/`.fail` suffix and a bare JSON object with a string
 * `ev` field -- and never hardcodes a verb name at all. A caller that
 * cares about one specific routine (`DistanceCalibrationWizard.tsx`'s
 * `calwheels`, `RotationCalibrationWizard.tsx`'s `calturn`) filters on
 * `event.verb` itself, in exactly one place (a single `const VERB = ...`
 * in that file) -- so a fourth rename, which "would not surprise
 * anyone" per the issue, touches one line in one wizard file, not this
 * parser.
 *
 * A line that is not a JSON object, or is a JSON object with no usable
 * `ev` string, returns `undefined` -- "not a calibration line", the
 * same tolerant contract the old prefixed-prose parser had. Callers
 * must keep tolerating this silently: the wire also carries `ack`/`err`
 * replies to the `RUN`/`SET` commands themselves, unrelated `DBG:`
 * lines, and (per the issue's "Lines get dropped" section) the
 * firmware's own best-effort ring can pack several JSON objects into
 * one frame or drop one outright while a motion obligation is live --
 * none of that is this parser's concern; it only ever answers "does
 * this one line parse, and if so as what".
 *
 * ## Never a confident wrong number
 *
 * `parseWheelsResult`/`parseTurnResult`/`parseTurnRestored` validate
 * every field they read (must be present and a finite `number`) before
 * returning anything -- a `.result`/`.restored` line with a missing or
 * malformed field yields `undefined`, which every call site must treat
 * as "couldn't read this run", never as a zero or a stale value. Extra,
 * unrecognized fields in the object are ignored, not rejected -- the
 * firmware has already added fields to these events once without
 * renaming the event itself (the `calj`/`calc` -> `calwheels`/`calturn`
 * rename kept every field name the same; a future field addition is
 * exactly the kind of change this parser should absorb for free).
 */

/** One parsed calibration JSON line, keyed off the `ev` field's
 * `<verb>.<suffix>` shape:
 *  - `"result"` -- the run's successful terminal line (`ev` ends in
 *    `.result`). `fields` is the object's own fields, `ev` stripped.
 *  - `"fail"` -- the run's failing terminal line (`ev` ends in `.fail`).
 *    `why` is the `why` field when it's a string, else `undefined` --
 *    a malformed/missing reason still counts as a fail (the suffix
 *    alone is authoritative for "did this run end, and how"), it just
 *    has no explanation to show.
 *  - `"other"` -- anything else (`.quality`, `.span`, `.ch`,
 *    `.restored`, or a suffix this project hasn't seen yet):
 *    non-terminal, tolerated, and shape-agnostic here -- a caller that
 *    knows what a particular `suffix` means (e.g. `calturn`'s
 *    `restored`) reads `fields` itself via {@link parseTurnRestored}.
 */
export type CalibrationEvent =
  | { kind: "result"; verb: string; ev: string; fields: Record<string, unknown> }
  | { kind: "fail"; verb: string; ev: string; why: string | undefined; fields: Record<string, unknown> }
  | { kind: "other"; verb: string; suffix: string; ev: string; fields: Record<string, unknown> };

/**
 * Parse one rx-log line as a calibration JSON-lines event. Returns
 * `undefined` for anything that isn't a JSON object with a non-empty
 * string `ev` field containing at least one `.` with text on both
 * sides -- "not a calibration line", never an error, mirroring the
 * retired prefixed-prose parser's own tolerant contract.
 */
export function parseCalibrationLine(line: string): CalibrationEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const ev = record.ev;
  if (typeof ev !== "string" || ev.length === 0) {
    return undefined;
  }
  const dot = ev.lastIndexOf(".");
  if (dot <= 0 || dot === ev.length - 1) {
    // No `<verb>.<suffix>` shape at all -- not a calibration line this
    // module understands.
    return undefined;
  }
  const verb = ev.slice(0, dot);
  const suffix = ev.slice(dot + 1);
  const fields: Record<string, unknown> = { ...record };
  delete fields.ev;

  if (suffix === "result") {
    return { kind: "result", verb, ev, fields };
  }
  if (suffix === "fail") {
    const why = typeof fields.why === "string" ? fields.why : undefined;
    return { kind: "fail", verb, ev, why, fields };
  }
  return { kind: "other", verb, suffix, ev, fields };
}

/** Read `key` out of `fields` as a `number`, or `undefined` if it's
 * absent, not a number, or not finite (`NaN`/`Infinity` from a
 * malformed line must never be treated as real data). */
export function numberField(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** All of `keys` present in `fields` as finite numbers, or `undefined`
 * if even one is missing/malformed -- the "never a confident wrong
 * number" gate every `.result`/`.restored` shape validator below is
 * built on. */
function requireNumbers<K extends string>(fields: Record<string, unknown>, keys: readonly K[]): Record<K, number> | undefined {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const value = numberField(fields, key);
    if (value === undefined) {
      return undefined;
    }
    out[key] = value;
  }
  return out;
}

/** `calwheels.result`'s fields (wire field names verbatim; see this
 * module's own doc comment -- field names have not changed across any
 * of the three verb renames). `wasCalib` is the wheel-calibration
 * constant (mm per shaft degree) the robot was running with *before*
 * this run, i.e. the value `diameter`/`calib` are replacing -- not yet
 * converted to a diameter, since that conversion is presentation, not
 * parsing. */
export interface WheelsResult {
  calib: number;
  diameterMm: number;
  measuredCm: number;
  trueCm: number;
  errorCm: number;
  wasCalib: number;
}

/** Validate and extract a `calwheels.result` line's fields. `undefined`
 * for anything missing or non-numeric -- a malformed result must read
 * as "couldn't read this run", never as a wrong diameter. */
export function parseWheelsResult(fields: Record<string, unknown>): WheelsResult | undefined {
  const core = requireNumbers(fields, ["calib", "diameter", "measured", "true", "error", "was"] as const);
  if (!core) {
    return undefined;
  }
  return {
    calib: core.calib,
    diameterMm: core.diameter,
    measuredCm: core.measured,
    trueCm: core.true,
    errorCm: core.error,
    wasCalib: core.was,
  };
}

/** `calturn.result`'s fields. `trackWidthCm` (`tw`) is this robot's own
 * track width from its boot record -- a record, not a fresh
 * measurement. `slip` is `tw / b`, already divided by the firmware; per
 * `clasi/issues/calibration-calj-calc-one-click.md` this is "the value
 * to store" -- never `slipAtAnchor` (`slip_at_tw` under the old
 * `calc` name), which is checkable-arithmetic scaffolding against the
 * *anchor* geometry `calturn` temporarily overwrote the robot with, not
 * this robot's own slip. Only `b`, `trackWidthCm`, and `slip` are
 * required; the rest are optional context shown when present. */
export interface TurnResult {
  b: number;
  trackWidthCm: number;
  slip: number;
  gaps?: number | undefined;
  anchorTrackWidthCm?: number | undefined;
  slipAtAnchor?: number | undefined;
  slope?: number | undefined;
  anchorB?: number | undefined;
}

/** Validate and extract a `calturn.result` line's fields. Requires `b`,
 * `tw`, and `slip` to be present, finite numbers; everything else is
 * optional. `undefined` for anything missing or non-numeric on the
 * required trio. */
export function parseTurnResult(fields: Record<string, unknown>): TurnResult | undefined {
  const core = requireNumbers(fields, ["b", "tw", "slip"] as const);
  if (!core) {
    return undefined;
  }
  return {
    b: core.b,
    trackWidthCm: core.tw,
    slip: core.slip,
    gaps: numberField(fields, "gaps"),
    anchorTrackWidthCm: numberField(fields, "anchor_tw"),
    slipAtAnchor: numberField(fields, "slip_at_anchor"),
    slope: numberField(fields, "slope"),
    anchorB: numberField(fields, "anchor_b"),
  };
}

/** `calturn.restored`'s fields -- what `calturn` put back on the robot
 * after temporarily overwriting its geometry with an anchor to run, on
 * *both* the success and failure path. This is the one source of truth
 * for "what is this robot's geometry actually running right now", and
 * it can be silently dropped like any other progress line -- callers
 * must never assume it arrived. */
export interface RestoredGeometry {
  trackWidthCm: number;
  slip: number;
}

/** Validate and extract a `calturn.restored` line's fields. `undefined`
 * for anything missing or non-numeric. */
export function parseTurnRestored(fields: Record<string, unknown>): RestoredGeometry | undefined {
  const core = requireNumbers(fields, ["tw", "slip"] as const);
  if (!core) {
    return undefined;
  }
  return { trackWidthCm: core.tw, slip: core.slip };
}

/** Render a non-terminal event's fields as one readable progress line,
 * e.g. `calturn.quality sd=3.706 spread=0.051 ch=4` -- there is no
 * human-authored prose left on the wire to show verbatim (the old
 * `CALX:`/`CALA:` routines narrated in English; the JSON routines just
 * report numbers), so this is the plain, generic rendering every
 * "other" event gets. */
export function formatCalibrationEvent(ev: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length > 0 ? `${ev} ${parts.join(" ")}` : ev;
}
