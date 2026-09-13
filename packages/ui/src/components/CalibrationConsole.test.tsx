// @vitest-environment jsdom
/**
 * CalibrationConsole.test.tsx — direct coverage of
 * `isCalibrationConsoleEntry`'s pure filter logic (ticket 018-010, item
 * 3), mirroring `DistanceCalibrationWizard.tsx`'s own
 * `deriveDistanceCalibrationRun` test discipline: exercise the pure
 * predicate against fixture log slices, rather than only through a
 * mounted component. `CalibrationPage.test.tsx`'s own
 * "CalibrationConsole" describe block covers the mounted, FakeSocket-
 * driven behavior (Clear's own id-watermark, the console showing up
 * below the code block).
 */
import { describe, expect, it } from "vitest";
import type { LogEntry } from "../ws/WsProvider";
import { isCalibrationConsoleEntry } from "./CalibrationConsole";

function entries(lines: Array<{ direction: "tx" | "rx"; line: string }>): LogEntry[] {
  return lines.map((l, index) => ({ id: index, ...l }));
}

function filtered(lines: Array<{ direction: "tx" | "rx"; line: string }>): string[] {
  const log = entries(lines);
  return log.filter((_, index) => isCalibrationConsoleEntry(log, index)).map((e) => e.line);
}

describe("isCalibrationConsoleEntry", () => {
  it("keeps any CAL*: report line, whatever the calibration prefix", () => {
    expect(
      filtered([
        { direction: "rx", line: "CALX:diameter=90.68 mm" },
        { direction: "rx", line: "CALA:pass clockwise" },
        { direction: "rx", line: "CALB:whatever a future routine says" },
      ]),
    ).toEqual(["CALX:diameter=90.68 mm", "CALA:pass clockwise", "CALB:whatever a future routine says"]);
  });

  it("drops ordinary console traffic that isn't the calibration program's own", () => {
    expect(
      filtered([
        { direction: "tx", line: "hello #1" },
        { direction: "rx", line: "id diffdrive calibration-0.1 0.1 gopiv #1" },
        { direction: "tx", line: "get name #2" },
        { direction: "rx", line: "get name value #2" },
        { direction: "rx", line: "status a=1" },
      ]),
    ).toEqual([]);
  });

  it("keeps a RUN tx line for a cal* function and the ack/err reply immediately following it", () => {
    expect(
      filtered([
        { direction: "tx", line: "run calx #3" },
        { direction: "rx", line: "ack 3 1 none" },
      ]),
    ).toEqual(["run calx #3", "ack 3 1 none"]);

    expect(
      filtered([
        { direction: "tx", line: "run calb #7" },
        { direction: "rx", line: "err 1 #7" },
      ]),
    ).toEqual(["run calb #7", "err 1 #7"]);
  });

  it("does not keep a RUN tx line for a non-calibration function, or its reply", () => {
    expect(
      filtered([
        { direction: "tx", line: "run line #1" },
        { direction: "rx", line: "ack 1 1 none" },
      ]),
    ).toEqual([]);
  });

  it("does not keep an ack/err that follows an unrelated tx line, even if a cal* RUN happened earlier", () => {
    expect(
      filtered([
        { direction: "tx", line: "run calx #1" },
        { direction: "rx", line: "ack 1 1 none" },
        { direction: "tx", line: "get name #2" },
        { direction: "rx", line: "ack 2 1 none" },
      ]),
    ).toEqual(["run calx #1", "ack 1 1 none"]);
  });
});
