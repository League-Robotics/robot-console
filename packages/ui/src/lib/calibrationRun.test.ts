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

describe("a terminal line lost on the way back", () => {
  const BEFORE_VALUES =
    '{"ev":"calstore.values","wheel":0.783,"tw":11.42,"slip":1.0212,"has_wheel":1,"has_turn":1,"live_tw":11.42,"live_slip":1.021}';
  const runsLine = (wheelRuns: number) =>
    `{"ev":"calstore.runs","wheel_runs":${wheelRuns},"wheel_mean":0.7851,"turn_runs":1,"turn_mean":1.0212}`;
  const before = { values: { wheelCalib: 0.783, hasWheel: true } as never, runs: { wheelRuns: 3, turnRuns: 1 } };

  // tigez over Wi-Fi, 2026-10-24: the whole forward leg, result included,
  // never arrived; only the drive home did.
  const tigez = [
    tx("RUN calwheels 90 0 #11"),
    rx("ack 11 0 none"),
    rx("CALWHEELS:begin true=90cm scale=0.7878mm/deg wheel=unknown"),
    rx("CALWHEELS:hometrk x=28.5cm bar=..#. err=0 h=0.7 steer=-0.16"),
  ];

  it("recovers a wheel run the robot stored from the queued calshow reply", () => {
    const stored = BEFORE_VALUES.replace('"wheel":0.783', '"wheel":0.7912');
    const run = deriveWheelsCalibrationRun([...tigez, rx(stored), rx(runsLine(4))], before);
    expect(run).toMatchObject({ kind: "recovered", calib: 0.7912, wasCalib: 0.783 });
  });

  it("calls it lost when the robot stored nothing", () => {
    expect(deriveWheelsCalibrationRun([...tigez, rx(BEFORE_VALUES), rx(runsLine(3))], before).kind).toBe("lost");
  });

  it("calls it lost when there is nothing to compare against", () => {
    expect(deriveWheelsCalibrationRun([...tigez, rx(BEFORE_VALUES), rx(runsLine(4))]).kind).toBe("lost");
  });

  it("keeps running when a calshow reply from before the run lands after the click", () => {
    const run = deriveWheelsCalibrationRun(
      [tx("RUN calwheels 90 0 #11"), rx(BEFORE_VALUES), rx(runsLine(3)), rx("ack 11 0 none")],
      before,
    );
    expect(run.kind).toBe("running");
  });

  it("prefers a result that did arrive", () => {
    const run = deriveWheelsCalibrationRun([...tigez, rx(WHEELS_RESULT), rx(BEFORE_VALUES), rx(runsLine(4))], before);
    expect(run.kind).toBe("succeeded");
  });

  it("reports a turn run whose result was lost", () => {
    const run = deriveTurnCalibrationRun([tx("RUN calturn 10 #12"), rx("ack 12 0 none"), rx(runsLine(3))]);
    expect(run.kind).toBe("lost");
  });
});

describe("a turn result lost on the way back", () => {
  // tigez over radio, 2026-10-24: calturn.result and calturn.stored
  // never arrived; everything around them did.
  const VALUES =
    '{"ev":"calstore.values","wheel":0.7843,"tw":11.42,"slip":0.9855,"has_wheel":1,"has_turn":1,"live_tw":11.42,"live_slip":0.986}';
  const runs = (turnRuns: number) => `{"ev":"calstore.runs","wheel_runs":6,"wheel_mean":0.7844,"turn_runs":${turnRuns},"turn_mean":1.0034}`;
  const before = { runs: { wheelRuns: 6, turnRuns: 1 } };
  const spin = [
    tx("SET wheel_diameter 89.88 #8"),
    tx("RUN calturn 10 #9"),
    tx("RUN _calshow #10"),
    rx("ack 8 0 none"),
    rx("ack 9 0 none"),
    rx("ack 10 0 none"),
    rx("CALTURN:begin edges=10 sector=45deg anchor b=11.996cm (track 11.42 slip 0.952) spin=70deg/s turn=left"),
    rx('{"ev":"calturn.quality","sd":4.851,"spread":0.614,"ch":4,"gap":43.469,"sector":45,"spin":70,"wheel":7.33}'),
    rx('{"ev":"calturn.restored","tw":11.42,"slip":0.986,"stored":1}'),
  ];

  it("rebuilds b from the anchor and the measured gap", () => {
    const run = deriveTurnCalibrationRun([...spin, rx(VALUES), rx(runs(2))], before);
    expect(run.kind).toBe("recovered");
    if (run.kind !== "recovered") return;
    expect(run.result.b).toBeCloseTo(11.588, 3);
    expect(run.result.slip).toBeCloseTo(0.9855, 4);
  });

  it("prefers calturn.stored's own run slip when it arrived", () => {
    const stored = rx('{"ev":"calturn.stored","run":0.9855,"slip":0.9855,"pair":"no"}');
    const run = deriveTurnCalibrationRun([...spin, stored, rx(VALUES), rx(runs(2))], before);
    expect(run.kind === "recovered" && run.result.b).toBeCloseTo(11.588, 2);
  });

  it("is lost when the robot stored nothing", () => {
    expect(deriveTurnCalibrationRun([...spin, rx(VALUES), rx(runs(1))], before).kind).toBe("lost");
  });
});
