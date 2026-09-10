/**
 * CalibrationReport.test.ts — table-driven tests for
 * `parseCalibrationLine` against representative `CALX:`/`CALA:`
 * fixture lines (ticket 003's Testing plan): progress, apply, fail,
 * and a non-matching line, for both prefixes.
 */
import { describe, expect, it } from "vitest";
import { parseCalibrationLine, type CalibrationPrefix } from "./CalibrationReport";

describe("parseCalibrationLine", () => {
  const prefixes: CalibrationPrefix[] = ["CALX", "CALA"];

  for (const prefix of prefixes) {
    describe(`prefix ${prefix}`, () => {
      it("parses a progress line, carrying the raw remainder text verbatim", () => {
        expect(parseCalibrationLine(prefix, `${prefix}:begin true=90cm baseline=0.7878mm/deg`)).toEqual({
          kind: "progress",
          text: "begin true=90cm baseline=0.7878mm/deg",
        });
        expect(parseCalibrationLine(prefix, `${prefix}:start line found`)).toEqual({
          kind: "progress",
          text: "start line found",
        });
        expect(parseCalibrationLine(prefix, `${prefix}:measured=90.5cm true=90cm error=0.5cm`)).toEqual({
          kind: "progress",
          text: "measured=90.5cm true=90cm error=0.5cm",
        });
      });

      it("parses an apply line, extracting only the snippet after the 'apply ' marker", () => {
        expect(
          parseCalibrationLine(prefix, `${prefix}:apply diffDrive.setWheelCalibration(0.7912)`),
        ).toEqual({
          kind: "apply",
          snippet: "diffDrive.setWheelCalibration(0.7912)",
        });
      });

      it("parses a fail line, extracting the reason after the 'fail ' marker", () => {
        expect(parseCalibrationLine(prefix, `${prefix}:fail no start line within 60cm`)).toEqual({
          kind: "fail",
          reason: "no start line within 60cm",
        });
      });

      it("parses a bare 'fail' with no reason text as an empty reason", () => {
        expect(parseCalibrationLine(prefix, `${prefix}:fail`)).toEqual({ kind: "fail", reason: "" });
      });

      it("parses a bare 'apply' with no snippet text as an empty snippet", () => {
        expect(parseCalibrationLine(prefix, `${prefix}:apply`)).toEqual({ kind: "apply", snippet: "" });
      });

      it("returns undefined for a line not matching this prefix's marker", () => {
        expect(parseCalibrationLine(prefix, "err 1 #3")).toBeUndefined();
        expect(parseCalibrationLine(prefix, "ack 5 0 none")).toBeUndefined();
        expect(parseCalibrationLine(prefix, "# link opened")).toBeUndefined();
        expect(parseCalibrationLine(prefix, "")).toBeUndefined();
      });

      it("tolerates leading/trailing whitespace around the line", () => {
        expect(parseCalibrationLine(prefix, `  ${prefix}:start line found  `)).toEqual({
          kind: "progress",
          text: "start line found",
        });
      });
    });
  }

  it("does not cross-match the other prefix's lines", () => {
    expect(parseCalibrationLine("CALX", "CALA:apply diffDrive.setConfigValue(ConfigField.RotationalSlip, 0.958)")).toBeUndefined();
    expect(parseCalibrationLine("CALA", "CALX:apply diffDrive.setWheelCalibration(0.7912)")).toBeUndefined();
  });

  it("never fabricates a snippet from a progress line -- only an explicit apply event carries one", () => {
    const event = parseCalibrationLine("CALX", "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    expect(event?.kind).toBe("progress");
    expect(event).not.toHaveProperty("snippet");
  });
});
