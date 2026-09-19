/**
 * CalibrationStore.test.ts — pure-function coverage for
 * `deriveCalStoreState`, mirroring `DistanceCalibrationWizard.test.tsx`'s
 * own `deriveWheelsCalibrationRun` unit tests (fixture log slices, no
 * mounted component). See `CalibrationStore.ts`'s own doc comment for
 * why this scans the whole log rather than a run-anchored window.
 */
import { describe, expect, it } from "vitest";
import { deriveCalStoreState } from "./CalibrationStore";

function rx(line: string): { direction: "tx" | "rx"; line: string } {
  return { direction: "rx", line };
}

const VALUES_BOTH =
  '{"ev":"calstore.values","wheel":0.7856,"tw":11.42,"slip":1.008,"has_wheel":1,"has_turn":1,"live_tw":11.42,"live_slip":1.008}';
const RUNS = '{"ev":"calstore.runs","wheel_runs":3,"turn_runs":1}';

describe("deriveCalStoreState", () => {
  it("returns everything undefined/false for an empty log", () => {
    expect(deriveCalStoreState([])).toEqual({ values: undefined, runs: undefined, justCleared: false, bootHint: undefined });
  });

  it("adopts calstore.values and calstore.runs independently", () => {
    const state = deriveCalStoreState([rx(VALUES_BOTH), rx(RUNS)]);
    expect(state.values).toEqual({
      wheelCalib: 0.7856,
      trackWidthCm: 11.42,
      slip: 1.008,
      hasWheel: true,
      hasTurn: true,
      liveTrackWidthCm: 11.42,
      liveSlip: 1.008,
    });
    expect(state.runs).toEqual({
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
    expect(state.justCleared).toBe(false);
  });

  it("last calstore.values wins over an earlier one", () => {
    const has_wheel_only =
      '{"ev":"calstore.values","wheel":0.7856,"tw":0,"slip":0,"has_wheel":1,"has_turn":0,"live_tw":11.5,"live_slip":1}';
    const state = deriveCalStoreState([rx(has_wheel_only), rx(VALUES_BOTH)]);
    expect(state.values?.hasTurn).toBe(true);
  });

  it("calstore.cleared resets both values and runs, and sets justCleared", () => {
    const state = deriveCalStoreState([rx(VALUES_BOTH), rx(RUNS), rx('{"ev":"calstore.cleared"}')]);
    expect(state.values).toBeUndefined();
    expect(state.runs).toBeUndefined();
    expect(state.justCleared).toBe(true);
  });

  it("a fresh calstore.values after a clear supersedes the cleared state", () => {
    const state = deriveCalStoreState([rx(VALUES_BOTH), rx('{"ev":"calstore.cleared"}'), rx(VALUES_BOTH)]);
    expect(state.values).toBeDefined();
    expect(state.justCleared).toBe(false);
  });

  it("a malformed calstore.values line (missing required field) is not adopted, leaving prior state standing", () => {
    const malformed = '{"ev":"calstore.values","wheel":0.7856,"tw":11.42,"slip":1.008,"has_wheel":1,"has_turn":1,"live_tw":11.42}';
    const state = deriveCalStoreState([rx(VALUES_BOTH), rx(malformed)]);
    // The malformed line (missing live_slip) doesn't overwrite the good one.
    expect(state.values?.liveSlip).toBe(1.008);
  });

  it("ignores lines from a different verb entirely", () => {
    const state = deriveCalStoreState([rx('{"ev":"calturn.result","b":1,"tw":2,"slip":3}'), rx(VALUES_BOTH)]);
    expect(state.values).toBeDefined();
  });

  it("ignores tx lines and non-calibration noise", () => {
    const state = deriveCalStoreState([
      { direction: "tx", line: "RUN calshow" },
      rx("ack 5 0 none"),
      rx(VALUES_BOTH),
    ]);
    expect(state.values).toBeDefined();
  });

  describe("the boot cal line", () => {
    it("is captured as an opportunistic hint when no calstore.values has arrived", () => {
      const state = deriveCalStoreState([rx("boot cal wheel=0.7878 tw=11.42 slip=1.0 runs=3/1")]);
      expect(state.bootHint).toEqual({ none: false, wheelCalib: 0.7878, trackWidthCm: 11.42, slip: 1.0, wheelRuns: 3, turnRuns: 1 });
      expect(state.values).toBeUndefined();
    });

    it("boot cal none stored captures none:true", () => {
      const state = deriveCalStoreState([rx("boot cal none stored")]);
      expect(state.bootHint).toEqual({ none: true });
    });

    it("is kept even after a later calstore.values arrives (callers decide precedence, not this deriver)", () => {
      const state = deriveCalStoreState([rx("boot cal none stored"), rx(VALUES_BOTH)]);
      expect(state.bootHint).toEqual({ none: true });
      expect(state.values).toBeDefined();
    });
  });
});
