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
  /** `calwheels.result`'s `stored` field (0/1) -- profile
   * `calibration-0.20260919.4`: whether the robot is now *running* this
   * measurement, not merely reporting it. Optional and read defensively
   * (see this field's twin on {@link RestoredGeometry}): absent or
   * non-numeric (older firmware) reads as `undefined`, never a
   * fabricated `false` -- "don't know" and "confirmed not running it"
   * are different claims and must stay distinguishable. */
  stored?: boolean | undefined;
}

/** Validate and extract a `calwheels.result` line's fields. `undefined`
 * for anything missing or non-numeric -- a malformed result must read
 * as "couldn't read this run", never as a wrong diameter. */
export function parseWheelsResult(fields: Record<string, unknown>): WheelsResult | undefined {
  const core = requireNumbers(fields, ["calib", "diameter", "measured", "true", "error", "was"] as const);
  if (!core) {
    return undefined;
  }
  const storedRaw = numberField(fields, "stored");
  return {
    calib: core.calib,
    diameterMm: core.diameter,
    measuredCm: core.measured,
    trueCm: core.true,
    errorCm: core.error,
    wasCalib: core.was,
    stored: storedRaw === undefined ? undefined : storedRaw !== 0,
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
  /** `calturn.restored`'s `stored` field (0/1) -- profile
   * `calibration-0.20260919.4` fixed the restore ordering: it now
   * happens *before* `calturn.fail` is announced, and this event's
   * `stored` says which geometry is actually running.
   * `stored:1` (success path): this is the geometry the robot is
   * running, and it survives a power cycle. `stored:0` (failure path):
   * the robot has been put back on its prior geometry -- it is *not*
   * still running this run's anchor -- and that prior geometry is not
   * necessarily persisted (it may itself have been a runtime `SET`).
   * Optional and read defensively: absent/non-numeric (older firmware,
   * or the pre-fix ordering where this line could still be dropped like
   * any other progress line) reads as `undefined`, and callers must
   * never assert a restore from documentation alone when this field
   * didn't arrive -- see `RotationCalibrationWizard.tsx`'s own doc
   * comment. */
  stored?: boolean | undefined;
}

/** Validate and extract a `calturn.restored` line's fields. `undefined`
 * for anything missing or non-numeric. */
export function parseTurnRestored(fields: Record<string, unknown>): RestoredGeometry | undefined {
  const core = requireNumbers(fields, ["tw", "slip"] as const);
  if (!core) {
    return undefined;
  }
  const storedRaw = numberField(fields, "stored");
  return { trackWidthCm: core.tw, slip: core.slip, stored: storedRaw === undefined ? undefined : storedRaw !== 0 };
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

/**
 * `calstore.values` -- one of the two objects `calshow` emits (profile
 * `calibration-0.20260919.4`; see `clasi/issues/calibration-calj-calc-one-click.md`).
 * Parses as an `"other"` {@link CalibrationEvent} (`verb: "calstore"`,
 * `suffix: "values"`) -- no new verb-detection machinery needed.
 *
 * `hasWheel`/`hasTurn` are the *authority* for "is this calibration
 * stored" -- never inferred from `wheelCalib > 0`/`trackWidthCm > 0`.
 * `wheelCalib`/`trackWidthCm`/`slip` are the *persisted* (survives a
 * power cycle) calibration, meaningful only when the matching `has*`
 * flag is set (0 when never stored, per the wire contract -- but the
 * flag, not the zero, is what a caller must branch on). `liveTrackWidthCm`/
 * `liveSlip` are independent of storage: what the robot is *actually
 * running* right now (a compiled default when nothing was ever stored,
 * or a runtime `SET rotational_slip` that was never saved to the
 * store) -- the honest source for a pasted code line, since a student
 * cares what the robot does, not just what survived its last boot.
 *
 * All seven fields are required for this to parse -- a
 * `calstore.values` line with even one missing/non-numeric field
 * degrades to `undefined` rather than a partially-trusted object, since
 * `hasWheel`/`hasTurn` are exactly the fields this module warns never
 * to guess at.
 */
export interface CalstoreValues {
  /** mm per shaft degree, the persisted wheel calibration -- 0 if
   * `hasWheel` is false. Never used as the "is it stored" signal. */
  wheelCalib: number;
  /** cm, the persisted track width -- meaningless if `hasTurn` is
   * false. */
  trackWidthCm: number;
  /** The persisted rotational slip -- meaningless if `hasTurn` is
   * false. */
  slip: number;
  hasWheel: boolean;
  hasTurn: boolean;
  /** cm, what the robot's track width actually is right now, whatever
   * its origin (stored, runtime `SET`, or compiled default). */
  liveTrackWidthCm: number;
  /** What the robot's rotational slip actually is right now, whatever
   * its origin. */
  liveSlip: number;
}

/** Validate and extract a `calstore.values` line's fields (the
 * `calstore` verb's `fields`, `ev` already stripped by
 * {@link parseCalibrationLine}). `undefined` if any of the seven
 * required fields is missing or non-numeric. */
export function parseCalstoreValues(fields: Record<string, unknown>): CalstoreValues | undefined {
  const core = requireNumbers(fields, ["wheel", "tw", "slip", "has_wheel", "has_turn", "live_tw", "live_slip"] as const);
  if (!core) {
    return undefined;
  }
  return {
    wheelCalib: core.wheel,
    trackWidthCm: core.tw,
    slip: core.slip,
    hasWheel: core.has_wheel !== 0,
    hasTurn: core.has_turn !== 0,
    liveTrackWidthCm: core.live_tw,
    liveSlip: core.live_slip,
  };
}

/**
 * `calstore.runs` -- the second of the two objects `calshow` emits: run
 * statistics behind the stored value since the last `calclear`. This is
 * the mechanism that makes "the robot keeps the *last* run's value
 * rather than a mean" safe: a single run (`wheelRuns`/`turnRuns === 1`)
 * is not a precise estimate (sd 0.16%-0.43% measured on hardware, up to
 * 1.2% between extremes on `vevov`), so this data is what lets a
 * consumer draw a student's eye to "one sample" rather than "a settled
 * fact". `wheelMean`/`turnMean` are reported for exactly that framing
 * and must never be applied -- the robot always runs its last
 * successful run's value, never a mean.
 *
 * Only the two run counts are required; every other field is optional
 * context, read defensively field-by-field so a firmware that hasn't
 * accumulated enough runs yet for a spread (or an older build missing
 * some fields) still reports whatever it has.
 */
export interface CalstoreRuns {
  wheelRuns: number;
  turnRuns: number;
  /** Reported for context only -- never applied; the robot always runs
   * its last successful run's own value. */
  wheelMean?: number | undefined;
  turnMean?: number | undefined;
  wheelLo?: number | undefined;
  wheelHi?: number | undefined;
  turnLo?: number | undefined;
  turnHi?: number | undefined;
  /** `(hi - lo)` as a percent of the mean. */
  wheelSpreadPct?: number | undefined;
  turnSpreadPct?: number | undefined;
}

/** Validate and extract a `calstore.runs` line's fields. `undefined`
 * only if either run count is missing/non-numeric; every other field
 * degrades individually to `undefined` rather than failing the whole
 * object. */
export function parseCalstoreRuns(fields: Record<string, unknown>): CalstoreRuns | undefined {
  const core = requireNumbers(fields, ["wheel_runs", "turn_runs"] as const);
  if (!core) {
    return undefined;
  }
  return {
    wheelRuns: core.wheel_runs,
    turnRuns: core.turn_runs,
    wheelMean: numberField(fields, "wheel_mean"),
    turnMean: numberField(fields, "turn_mean"),
    wheelLo: numberField(fields, "wheel_lo"),
    wheelHi: numberField(fields, "wheel_hi"),
    turnLo: numberField(fields, "turn_lo"),
    turnHi: numberField(fields, "turn_hi"),
    wheelSpreadPct: numberField(fields, "wheel_spread"),
    turnSpreadPct: numberField(fields, "turn_spread"),
  };
}

/** The prefix `boot cal ...` lines always start with -- plain text, not
 * JSON, so it is never seen by {@link parseCalibrationLine} (which
 * bails out before touching anything that doesn't start with `{`, and
 * must go on doing so unweakened -- see this function's own doc
 * comment on why it is a wholly separate check, not a fallback folded
 * into that parser). */
const BOOT_CAL_PREFIX = "boot cal";

/**
 * One `boot cal ...` line -- an opportunistic hint printed once at
 * boot, either `boot cal wheel=<calib> tw=<tw> slip=<slip> runs=<w>/<t>`
 * or `boot cal none stored`. Plain text, not JSON, so this is a
 * deliberately separate function from {@link parseCalibrationLine}
 * rather than a case inside it -- that parser's whole contract is "not
 * a JSON object with a usable `ev` field is not a calibration line",
 * and folding a prefix-prose format back into it would weaken that
 * tolerance test for every other caller that relies on it to cheaply
 * skip non-JSON noise. A caller that wants both simply tries
 * {@link parseCalibrationLine} first and falls back to this function --
 * see `CalibrationStore.ts`.
 *
 * This is an *opportunistic hint only* -- printed once, best-effort,
 * before a computer is necessarily even listening -- never the
 * authoritative read; `calshow`'s `calstore.values` is. Parsed
 * token-by-token (`key=value`, whitespace-separated) rather than one
 * rigid whole-line regex, so a boot line with a field this module
 * doesn't recognize, or missing one it does, still yields whatever it
 * has instead of failing to parse at all -- the same "never a
 * fabricated number" discipline as {@link requireNumbers}, applied
 * field-by-field instead of all-or-nothing (there is no `has_wheel`/
 * `has_turn` authority flag on this line to gate on, so a caller must
 * still treat this as a hint to be superseded, never a confident
 * "stored"/"not stored" answer of its own).
 */
export interface BootCalHint {
  /** True for the literal `boot cal none stored` line -- neither
   * calibration was stored at boot. */
  none: boolean;
  wheelCalib?: number | undefined;
  trackWidthCm?: number | undefined;
  slip?: number | undefined;
  wheelRuns?: number | undefined;
  turnRuns?: number | undefined;
}

export function parseBootCalLine(line: string): BootCalHint | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(BOOT_CAL_PREFIX)) {
    return undefined;
  }
  const rest = trimmed.slice(BOOT_CAL_PREFIX.length).trim();
  if (rest === "none stored") {
    return { none: true };
  }
  const hint: BootCalHint = { none: false };
  let recognized = false;
  for (const token of rest.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "wheel") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        hint.wheelCalib = n;
        recognized = true;
      }
    } else if (key === "tw") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        hint.trackWidthCm = n;
        recognized = true;
      }
    } else if (key === "slip") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        hint.slip = n;
        recognized = true;
      }
    } else if (key === "runs") {
      const [wRaw, tRaw] = value.split("/");
      const w = Number(wRaw);
      const t = Number(tRaw);
      if (wRaw !== undefined && Number.isFinite(w)) {
        hint.wheelRuns = w;
        recognized = true;
      }
      if (tRaw !== undefined && Number.isFinite(t)) {
        hint.turnRuns = t;
        recognized = true;
      }
    }
  }
  // Not one token recognized -- this isn't a `boot cal` shape this
  // module understands, so it's not a hint at all rather than an empty
  // one that would render as "cleared".
  return recognized ? hint : undefined;
}
