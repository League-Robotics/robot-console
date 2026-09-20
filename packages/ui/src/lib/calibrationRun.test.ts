/**
 * calibrationRun.test.ts — the drop-tolerance property, carried over
 * from the two wizard test files when their panels were replaced by
 * `NewCalibrationPanel` (2026-09-19).
 *
 * These are the assertions worth keeping from those 930 lines: the rest
 * exercised UI that no longer exists. What matters here is that a run's
 * outcome is decided by the lines that ARRIVED, because on this fleet a
 * third of them may not — see the module's own doc comment.
 */
import { describe, expect, it } from "vitest";
import { deriveTurnCalibrationRun, deriveWheelsCalibrationRun, type RunLogEntry } from "./calibrationRun";

const rx = (line: string): RunLogEntry => ({ direction: "rx", line });
const tx = (line: string): RunLogEntry => ({ direction: "tx", line });

const WHEELS_RESULT =
  '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}';
const TURN_RESULT = '{"ev":"calturn.result","b":8.84,"tw":11.5,"slip":1.301}';

describe("deriveWheelsCalibrationRun", () => {
  it("is running until something terminal arrives", () => {
    expect(deriveWheelsCalibrationRun([]).kind).toBe("running");
    expect(deriveWheelsCalibrationRun([rx('{"ev":"calwheels.span","lo":81,"hi":99}')]).kind).toBe("running");
  });

  it("reads a result, and ignores everything that is not an inbound line", () => {
    const run = deriveWheelsCalibrationRun([tx("RUN calwheels 90 0"), rx(WHEELS_RESULT)]);
    expect(run.kind).toBe("succeeded");
    if (run.kind !== "succeeded") return;
    expect(run.result.diameterMm).toBe(90.68);
    expect(run.result.wasCalib).toBe(0.7878);
  });

  it("succeeds with the quality and span lines missing entirely", () => {
    // The whole point: a Wi-Fi burst can drop any non-terminal line and
    // the run must still land.
    expect(deriveWheelsCalibrationRun([rx(WHEELS_RESULT)]).kind).toBe("succeeded");
  });

  it("carries a failure's reason and the wheel its endpoints implied", () => {
    const run = deriveWheelsCalibrationRun([
      rx('{"ev":"calwheels.fail","why":"not on clear white","implied":778,"lo":81,"hi":99}'),
    ]);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.why).toBe("not on clear white");
    // 778 mm says the FIELD reading went wrong, not that the robot is
    // broken -- which is the difference a student can act on.
    expect(run.implied).toBe(778);
  });

  it("a result whose fields do not validate is unreadable, never a confident wrong diameter", () => {
    expect(deriveWheelsCalibrationRun([rx('{"ev":"calwheels.result","calib":"nonsense"}')]).kind).toBe("unreadable");
  });

  it("a bare err reply is the robot refusing the verb, not a failed routine", () => {
    expect(deriveWheelsCalibrationRun([rx("err 1 #4")]).kind).toBe("run-error");
  });

  it("ignores the other calibration's traffic on the same link", () => {
    const run = deriveWheelsCalibrationRun([rx(TURN_RESULT), rx("chatter, not json"), rx(WHEELS_RESULT)]);
    expect(run.kind).toBe("succeeded");
  });
});

describe("deriveTurnCalibrationRun", () => {
  it("reads a result", () => {
    const run = deriveTurnCalibrationRun([rx(TURN_RESULT)]);
    expect(run.kind).toBe("succeeded");
    if (run.kind !== "succeeded") return;
    expect(run.result.b).toBe(8.84);
    expect(run.result.trackWidthCm).toBe(11.5);
    expect(run.result.slip).toBe(1.301);
  });

  it("picks up calturn.restored, which arrives AFTER the terminal line", () => {
    const run = deriveTurnCalibrationRun([
      rx(TURN_RESULT),
      rx('{"ev":"calturn.restored","tw":11.36,"slip":0.793,"stored":1}'),
    ]);
    expect(run.kind).toBe("succeeded");
    expect(run.restored?.trackWidthCm).toBe(11.36);
  });

  it("restores are picked up on the failure path too", () => {
    const run = deriveTurnCalibrationRun([
      rx('{"ev":"calturn.fail","why":"too few usable gaps; centre the robot on the cross"}'),
      rx('{"ev":"calturn.restored","tw":11.36,"slip":0.793,"stored":1}'),
    ]);
    expect(run.kind).toBe("failed");
    expect(run.restored?.slip).toBe(0.793);
  });

  it("a duplicate terminal line does not overwrite the first", () => {
    const run = deriveTurnCalibrationRun([rx(TURN_RESULT), rx('{"ev":"calturn.fail","why":"stray"}')]);
    expect(run.kind).toBe("succeeded");
  });

  it("a bare err reply is a run-error", () => {
    expect(deriveTurnCalibrationRun([rx("err 1 #9")]).kind).toBe("run-error");
  });

  it("ignores the other calibration's traffic on the same link", () => {
    expect(deriveTurnCalibrationRun([rx(WHEELS_RESULT), rx(TURN_RESULT)]).kind).toBe("succeeded");
  });
});
