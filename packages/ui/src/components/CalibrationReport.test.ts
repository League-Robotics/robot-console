/**
 * CalibrationReport.test.ts — table-driven tests for
 * `parseCalibrationLine` and the `.result`/`.restored` shape validators
 * (rewritten OOP 2026-09-18 for the current firmware's JSON-lines
 * reports; see `CalibrationReport.ts`'s own doc comment). Fixtures are
 * taken from `clasi/issues/calibration-calj-calc-one-click.md`'s real
 * hardware capture (predating the `calwheels`/`calturn` rename, but the
 * shape, packing, and field names are unchanged) plus that issue's own
 * current-contract examples for `calwheels`/`calturn` themselves.
 */
import { describe, expect, it } from "vitest";
import {
  formatCalibrationEvent,
  numberField,
  parseBootCalLine,
  parseCalibrationLine,
  parseCalstoreRuns,
  parseCalstoreValues,
  parseTurnResult,
  parseTurnRestored,
  parseWheelsResult,
} from "./CalibrationReport";

describe("parseCalibrationLine", () => {
  it("parses a .result line, keying off the suffix -- verb and fields come along verbatim, `ev` stripped out of fields", () => {
    const event = parseCalibrationLine(
      '{"ev":"calturn.result","b":11.071,"tw":11.16,"slip":1.0080,"anchor_tw":11.42,"slip_at_anchor":1.0315,"slope":0.9229,"gaps":32,"anchor_b":11.996}',
    );
    expect(event).toEqual({
      kind: "result",
      verb: "calturn",
      ev: "calturn.result",
      fields: { b: 11.071, tw: 11.16, slip: 1.008, anchor_tw: 11.42, slip_at_anchor: 1.0315, slope: 0.9229, gaps: 32, anchor_b: 11.996 },
    });
    expect((event as { fields: Record<string, unknown> }).fields).not.toHaveProperty("ev");
  });

  it("parses a .fail line, extracting `why` when it's a string", () => {
    const event = parseCalibrationLine('{"ev":"calturn.fail","gaps":2,"why":"too few usable gaps; centre the robot on the cross"}');
    expect(event).toEqual({
      kind: "fail",
      verb: "calturn",
      ev: "calturn.fail",
      why: "too few usable gaps; centre the robot on the cross",
      fields: { gaps: 2, why: "too few usable gaps; centre the robot on the cross" },
    });
  });

  it("still classifies as fail when `why` is missing or not a string, just with why undefined", () => {
    expect(parseCalibrationLine('{"ev":"calwheels.fail"}')).toEqual({
      kind: "fail",
      verb: "calwheels",
      ev: "calwheels.fail",
      why: undefined,
      fields: {},
    });
    expect(parseCalibrationLine('{"ev":"calwheels.fail","why":42}')).toMatchObject({ kind: "fail", why: undefined });
  });

  it("parses any other suffix as a non-terminal 'other' event, verb-agnostic", () => {
    expect(parseCalibrationLine('{"ev":"calc.ch","i":0,"n":10,"gap":41.553,"sd":2.755,"slope":0.9234}')).toEqual({
      kind: "other",
      verb: "calc",
      suffix: "ch",
      ev: "calc.ch",
      fields: { i: 0, n: 10, gap: 41.553, sd: 2.755, slope: 0.9234 },
    });
    expect(parseCalibrationLine('{"ev":"calturn.restored","tw":11.16,"slip":0.969}')).toMatchObject({
      kind: "other",
      verb: "calturn",
      suffix: "restored",
    });
  });

  it("never hardcodes a verb -- an unrecognized/future verb still parses by shape alone", () => {
    expect(parseCalibrationLine('{"ev":"calnew.result","x":1}')).toEqual({
      kind: "result",
      verb: "calnew",
      ev: "calnew.result",
      fields: { x: 1 },
    });
  });

  it("returns undefined for non-JSON noise, acks/errs, and blank lines -- tolerated silently, never an error", () => {
    expect(parseCalibrationLine("err 1 #3")).toBeUndefined();
    expect(parseCalibrationLine("ack 5 0 none")).toBeUndefined();
    expect(parseCalibrationLine("# link opened")).toBeUndefined();
    expect(parseCalibrationLine("")).toBeUndefined();
    expect(parseCalibrationLine("status ready=1 cyc=12")).toBeUndefined();
  });

  it("returns undefined for a JSON object with no usable `ev` field", () => {
    expect(parseCalibrationLine('{"foo":"bar"}')).toBeUndefined();
    expect(parseCalibrationLine('{"ev":""}')).toBeUndefined();
    expect(parseCalibrationLine('{"ev":"noverb"}')).toBeUndefined();
    expect(parseCalibrationLine('{"ev":42}')).toBeUndefined();
  });

  it("returns undefined for a JSON value that isn't a bare object (array, string, number)", () => {
    expect(parseCalibrationLine('["ev","calturn.result"]')).toBeUndefined();
    expect(parseCalibrationLine("42")).toBeUndefined();
    expect(parseCalibrationLine('"just a string"')).toBeUndefined();
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(parseCalibrationLine('{"ev":"calturn.result", oops}')).toBeUndefined();
  });

  it("tolerates leading/trailing whitespace around the line", () => {
    expect(parseCalibrationLine('   {"ev":"calturn.restored","tw":11.16,"slip":0.969}   ')).toMatchObject({
      kind: "other",
      suffix: "restored",
    });
  });

  it("several objects packed onto conceptually one frame are each parsed independently when split into lines (the firmware packs several per frame, but the link log still delivers one JSON line at a time)", () => {
    const a = parseCalibrationLine('{"ev":"calc.ch","i":0,"n":10,"gap":41.553,"sd":2.755,"slope":0.9234}');
    const b = parseCalibrationLine(
      '{"ev":"calc.result","b":11.071,"tw":11.42,"slip_at_tw":1.0315,"slope":0.9229,"gaps":32,"anchor_b":11.996}',
    );
    const c = parseCalibrationLine('{"ev":"calc.quality","sd":3.706,"spread":0.051,"ch":4,"gap":41.53,"sector":45,"spin":70,"wheel":7.33}');
    expect(a?.kind).toBe("other");
    expect(b?.kind).toBe("result");
    expect(c?.kind).toBe("other");
  });
});

describe("numberField", () => {
  it("reads a finite number, and only a finite number", () => {
    expect(numberField({ x: 1.5 }, "x")).toBe(1.5);
    expect(numberField({ x: "1.5" }, "x")).toBeUndefined();
    expect(numberField({ x: NaN }, "x")).toBeUndefined();
    expect(numberField({ x: Infinity }, "x")).toBeUndefined();
    expect(numberField({}, "x")).toBeUndefined();
  });
});

describe("parseWheelsResult", () => {
  it("extracts all six calwheels.result fields when present and numeric", () => {
    expect(parseWheelsResult({ calib: 0.7856, diameter: 90.03, measured: 90.5, true: 90.2, error: 0.3, was: 0.7878 })).toEqual({
      calib: 0.7856,
      diameterMm: 90.03,
      measuredCm: 90.5,
      trueCm: 90.2,
      errorCm: 0.3,
      wasCalib: 0.7878,
    });
  });

  it("degrades to undefined -- 'couldn't read this run', never a confident wrong number -- when any required field is missing or non-numeric", () => {
    expect(parseWheelsResult({ calib: 0.7856, diameter: 90.03, measured: 90.5, true: 90.2, error: 0.3 })).toBeUndefined();
    expect(
      parseWheelsResult({ calib: 0.7856, diameter: 90.03, measured: 90.5, true: 90.2, error: 0.3, was: "0.7878" }),
    ).toBeUndefined();
  });

  it("does not choke on -- and ignores -- extra unrecognized fields (forward compatibility)", () => {
    expect(
      parseWheelsResult({ calib: 0.7856, diameter: 90.03, measured: 90.5, true: 90.2, error: 0.3, was: 0.7878, extra: "future field" }),
    ).toEqual({ calib: 0.7856, diameterMm: 90.03, measuredCm: 90.5, trueCm: 90.2, errorCm: 0.3, wasCalib: 0.7878 });
  });

  // Profile calibration-0.20260919.4: `calwheels.result` gains `stored`.
  it("reads stored:0/1 defensively -- present and numeric becomes a real boolean, absent/non-numeric stays undefined", () => {
    const base = { calib: 0.7912, diameter: 90.68, measured: 89.61, true: 90, error: -0.39, was: 0.7878 };
    expect(parseWheelsResult(base)?.stored).toBeUndefined();
    expect(parseWheelsResult({ ...base, stored: 1 })?.stored).toBe(true);
    expect(parseWheelsResult({ ...base, stored: 0 })?.stored).toBe(false);
    expect(parseWheelsResult({ ...base, stored: "1" })?.stored).toBeUndefined();
  });
});

describe("parseTurnResult", () => {
  it("extracts the required trio (b, tw, slip) plus the optional context fields, from the current contract's own example", () => {
    expect(
      parseTurnResult({
        b: 11.071,
        tw: 11.16,
        slip: 1.008,
        anchor_tw: 11.42,
        slip_at_anchor: 1.0315,
        slope: 0.9229,
        gaps: 32,
        anchor_b: 11.996,
      }),
    ).toEqual({
      b: 11.071,
      trackWidthCm: 11.16,
      slip: 1.008,
      gaps: 32,
      anchorTrackWidthCm: 11.42,
      slipAtAnchor: 1.0315,
      slope: 0.9229,
      anchorB: 11.996,
    });
  });

  it("succeeds with only the required trio present -- the optional fields are genuinely optional", () => {
    expect(parseTurnResult({ b: 11.071, tw: 11.16, slip: 1.008 })).toEqual({
      b: 11.071,
      trackWidthCm: 11.16,
      slip: 1.008,
      gaps: undefined,
      anchorTrackWidthCm: undefined,
      slipAtAnchor: undefined,
      slope: undefined,
      anchorB: undefined,
    });
  });

  it("degrades to undefined when b, tw, or slip is missing or non-numeric, regardless of what else is present", () => {
    expect(parseTurnResult({ tw: 11.16, slip: 1.008 })).toBeUndefined();
    expect(parseTurnResult({ b: 11.071, slip: 1.008 })).toBeUndefined();
    expect(parseTurnResult({ b: 11.071, tw: 11.16 })).toBeUndefined();
    expect(parseTurnResult({ b: 11.071, tw: "11.16", slip: 1.008 })).toBeUndefined();
  });

  it("the trap: slip_at_anchor is surfaced only as optional context, never in place of slip", () => {
    const result = parseTurnResult({ b: 11.071, tw: 11.42, slip: 1.0315, slip_at_anchor: 1.0315 })!;
    expect(result.slip).toBe(1.0315);
    expect(result).not.toHaveProperty("slipAtTw");
  });
});

describe("parseTurnRestored", () => {
  it("extracts tw/slip from a calturn.restored line", () => {
    expect(parseTurnRestored({ tw: 11.16, slip: 0.969 })).toEqual({ trackWidthCm: 11.16, slip: 0.969, stored: undefined });
  });

  it("degrades to undefined when either field is missing or non-numeric", () => {
    expect(parseTurnRestored({ tw: 11.16 })).toBeUndefined();
    expect(parseTurnRestored({ slip: 0.969 })).toBeUndefined();
    expect(parseTurnRestored({ tw: "11.16", slip: 0.969 })).toBeUndefined();
  });

  // Profile calibration-0.20260919.4: the restore-ordering fix, and
  // `stored` says which geometry the restore actually left running.
  it("reads stored:0/1 defensively -- present and numeric becomes a real boolean, absent/non-numeric stays undefined (never a fabricated false)", () => {
    expect(parseTurnRestored({ tw: 11.16, slip: 0.969, stored: 0 })).toEqual({ trackWidthCm: 11.16, slip: 0.969, stored: false });
    expect(parseTurnRestored({ tw: 11.16, slip: 0.969, stored: 1 })).toEqual({ trackWidthCm: 11.16, slip: 0.969, stored: true });
    expect(parseTurnRestored({ tw: 11.16, slip: 0.969, stored: "1" })?.stored).toBeUndefined();
  });
});

describe("parseCalstoreValues", () => {
  const FULL = { wheel: 0.7856, tw: 11.42, slip: 1.008, has_wheel: 1, has_turn: 1, live_tw: 11.42, live_slip: 1.008 };

  it("extracts all seven fields, has_wheel/has_turn as booleans", () => {
    expect(parseCalstoreValues(FULL)).toEqual({
      wheelCalib: 0.7856,
      trackWidthCm: 11.42,
      slip: 1.008,
      hasWheel: true,
      hasTurn: true,
      liveTrackWidthCm: 11.42,
      liveSlip: 1.008,
    });
  });

  it("has_wheel/has_turn are read as the 0/1 authority, never from wheel/tw > 0", () => {
    // wheel/tw are non-zero here but has_wheel/has_turn both say false --
    // the flags must still win.
    expect(parseCalstoreValues({ ...FULL, has_wheel: 0, has_turn: 0 })).toMatchObject({ hasWheel: false, hasTurn: false });
  });

  it("degrades to undefined -- never a partially-trusted object -- if even one of the seven fields is missing/non-numeric", () => {
    const { wheel: _wheel, ...missingWheel } = FULL;
    expect(parseCalstoreValues(missingWheel)).toBeUndefined();
    expect(parseCalstoreValues({ ...FULL, has_wheel: "1" })).toBeUndefined();
  });

  it("ignores extra unrecognized fields", () => {
    expect(parseCalstoreValues({ ...FULL, extra: "future field" })).toMatchObject({ hasWheel: true });
  });
});

describe("parseCalstoreRuns", () => {
  it("requires only the two run counts; every other field is independently optional", () => {
    expect(parseCalstoreRuns({ wheel_runs: 3, turn_runs: 1 })).toEqual({
      wheelRuns: 3,
      turnRuns: 1,
      wheelMean: undefined,
      turnMean: undefined,
      wheelLo: undefined,
      wheelHi: undefined,
      turnLo: undefined,
      turnHi: undefined,
      wheelSpreadPct: undefined,
      turnSpreadPct: undefined,
    });
  });

  it("extracts the optional context fields when present", () => {
    expect(
      parseCalstoreRuns({
        wheel_runs: 4,
        turn_runs: 3,
        wheel_mean: 90.1,
        turn_mean: 11.4,
        wheel_lo: 89.9,
        wheel_hi: 90.3,
        turn_lo: 11.3,
        turn_hi: 11.5,
        wheel_spread: 0.44,
        turn_spread: 1.8,
      }),
    ).toEqual({
      wheelRuns: 4,
      turnRuns: 3,
      wheelMean: 90.1,
      turnMean: 11.4,
      wheelLo: 89.9,
      wheelHi: 90.3,
      turnLo: 11.3,
      turnHi: 11.5,
      wheelSpreadPct: 0.44,
      turnSpreadPct: 1.8,
    });
  });

  it("degrades to undefined when either run count is missing or non-numeric", () => {
    expect(parseCalstoreRuns({ turn_runs: 1 })).toBeUndefined();
    expect(parseCalstoreRuns({ wheel_runs: "3", turn_runs: 1 })).toBeUndefined();
  });
});

describe("parseBootCalLine", () => {
  it("parses the full 'boot cal wheel=... tw=... slip=... runs=W/T' line", () => {
    expect(parseBootCalLine("boot cal wheel=0.7878 tw=11.42 slip=1.0 runs=3/1")).toEqual({
      none: false,
      wheelCalib: 0.7878,
      trackWidthCm: 11.42,
      slip: 1.0,
      wheelRuns: 3,
      turnRuns: 1,
    });
  });

  it("parses 'boot cal none stored' as none:true with no other fields", () => {
    expect(parseBootCalLine("boot cal none stored")).toEqual({ none: true });
  });

  it("tolerates a partial line, extracting whatever fields it recognizes", () => {
    expect(parseBootCalLine("boot cal wheel=0.7878")).toEqual({ none: false, wheelCalib: 0.7878 });
  });

  it("returns undefined for a line that isn't a boot cal line at all", () => {
    expect(parseBootCalLine("boot ready cyc=12")).toBeUndefined();
    expect(parseBootCalLine('{"ev":"calturn.result","b":1,"tw":2,"slip":3}')).toBeUndefined();
    expect(parseBootCalLine("")).toBeUndefined();
  });

  it("returns undefined for 'boot cal' with nothing recognizable after it, rather than an empty hint", () => {
    expect(parseBootCalLine("boot cal ???")).toBeUndefined();
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(parseBootCalLine("   boot cal none stored   ")).toEqual({ none: true });
  });
});

describe("formatCalibrationEvent", () => {
  it("renders a non-terminal event's fields as one readable line", () => {
    expect(formatCalibrationEvent("calturn.quality", { sd: 3.706, spread: 0.051, ch: 4 })).toBe(
      "calturn.quality sd=3.706 spread=0.051 ch=4",
    );
  });

  it("renders a bare ev with no fields as just the ev", () => {
    expect(formatCalibrationEvent("calturn.span", {})).toBe("calturn.span");
  });
});
