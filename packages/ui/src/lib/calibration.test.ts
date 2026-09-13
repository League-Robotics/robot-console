/**
 * lib/calibration.test.ts — pure-function coverage for the calibration
 * merge/derived-value math, moved out of `CalibrationPage.test.tsx`'s
 * "calibration maths" describe (ticket 017-008): these assertions
 * exercised module-level functions, not anything specific to the
 * `CalibrationPage` component, and used to be the one place this math
 * was tested even though `ConfigurationPage.tsx` also depended on it.
 */
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
  applyCalibrationPatch,
  calibrationCode,
  correctTrackWidth,
  deriveCalibration,
} from "./calibration";

describe("calibration maths", () => {
  it("corrects the reported track width by the ratio of the real wheel to the image's baseline wheel", () => {
    // Same wheel as the image assumed: no change.
    expect(correctTrackWidth(8.84, CALIBRATION_IMAGE_BASELINE_DIAMETER_MM, CALIBRATION_IMAGE_BASELINE_DIAMETER_MM)).toBe(8.84);
    // Real wheel 10% bigger: every commanded turn came out 10% larger,
    // so the routine under-reported the width by 10%.
    expect(correctTrackWidth(10, 90, 99)).toBe(11);
  });

  it("deriveCalibration: no measured track width -> the effective width is the track width and slip is 1", () => {
    expect(deriveCalibration({ wheelDiameterMm: 90.28, reportedTrackWidthCm: 8.84, reportedWithDiameterMm: 90.28 })).toEqual({
      effectiveTrackWidthCm: 8.84,
      trackWidthCm: 8.84,
      rotationalSlip: 1,
    });
  });

  it("deriveCalibration: a measured track width gives slip = measured / effective", () => {
    expect(
      deriveCalibration({ wheelDiameterMm: 90.28, measuredTrackWidthCm: 11.5, reportedTrackWidthCm: 8.84, reportedWithDiameterMm: 90.28 }),
    ).toEqual({ effectiveTrackWidthCm: 8.84, trackWidthCm: 11.5, rotationalSlip: 1.301 });
  });

  it("deriveCalibration: a rotation result without a wheel diameter yields nothing", () => {
    expect(deriveCalibration({ reportedTrackWidthCm: 8.84 })).toEqual({});
  });

  it("calibrationCode builds up line by line as information arrives", () => {
    expect(calibrationCode({}, "gopiv")).toBe("");
    expect(calibrationCode({ wheelDiameterMm: 90.68 }, "gopiv")).toBe(
      ["// gopiv calibration", "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)  // wheel diameter 90.68 mm"].join("\n"),
    );
    const full = calibrationCode(
      { wheelDiameterMm: 90.28, measuredTrackWidthCm: 11.5, reportedTrackWidthCm: 8.84, reportedWithDiameterMm: 90.28 },
      "gopiv",
    );
    expect(full.split("\n")).toEqual([
      "// gopiv calibration",
      "diffDrive.setWheelCalibration(90.28 * Math.PI / 360)  // wheel diameter 90.28 mm",
      "diffDrive.setTrackWidth(11.5)  // measured track width, cm",
      "diffDrive.setConfigValue(ConfigField.RotationalSlip, 1.301)  // measured 11.5 cm / effective 8.84 cm",
    ]);
    const unmeasured = calibrationCode({ wheelDiameterMm: 90.28, reportedTrackWidthCm: 8.84, reportedWithDiameterMm: 90.28 }, "gopiv");
    expect(unmeasured).toContain("diffDrive.setTrackWidth(8.84)  // effective track width, cm (not measured with a ruler)");
    expect(unmeasured).toContain("diffDrive.setConfigValue(ConfigField.RotationalSlip, 1)");
  });
});

describe("applyCalibrationPatch", () => {
  it("merges a patch over the previous state", () => {
    expect(applyCalibrationPatch({ wheelDiameterMm: 90 }, { measuredTrackWidthCm: 11.5 })).toEqual({
      wheelDiameterMm: 90,
      measuredTrackWidthCm: 11.5,
    });
  });

  it("strips a key whose patched value is undefined, rather than storing an explicit undefined", () => {
    const patched = applyCalibrationPatch({ wheelDiameterMm: 90, wheelDiameterSource: "entered" }, { wheelDiameterMm: undefined, wheelDiameterSource: undefined });
    expect(patched).toEqual({});
    expect(Object.keys(patched)).toHaveLength(0);
  });

  it("leaves keys the patch does not mention untouched", () => {
    expect(applyCalibrationPatch({ wheelDiameterMm: 90, measuredTrackWidthCm: 11.5 }, { measuredTrackWidthCm: undefined })).toEqual({
      wheelDiameterMm: 90,
    });
  });

  it("ticket 018-010: carries robotReportedSlip like any other field, and strips it the same way on undefined", () => {
    expect(applyCalibrationPatch({}, { robotReportedSlip: 1.301 })).toEqual({ robotReportedSlip: 1.301 });
    expect(applyCalibrationPatch({ robotReportedSlip: 1.301 }, { robotReportedSlip: undefined })).toEqual({});
  });
});
