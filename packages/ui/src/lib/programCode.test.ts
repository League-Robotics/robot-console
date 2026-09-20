/**
 * programCode.test.ts — ported from `ConfigurationPage.test.tsx`'s
 * `describe("configurationCode", ...)` block (ticket 022-001's move out
 * of that page into this shared `lib/` module), plus new cases
 * exercising the `calibrationOptions` pass-through that only
 * `CalibrationPage.tsx`'s own call site uses -- see `programCode.ts`'s
 * own doc comment for why that field exists and why `ConfigurationPage`
 * never passes it.
 */
import { describe, expect, it } from "vitest";
import { MASKED_PASSWORD, programCode } from "./programCode";

describe("programCode", () => {
  it("emits radio, masked Wi-Fi, and calibration lines in that order", () => {
    const code = programCode({
      robotName: "tigez",
      radio: { channel: 55, group: 114 },
      wifi: { ssid: "Busboom_Garage", password: undefined },
      calibration: { wheelDiameterMm: 90.68 },
    });
    expect(code.split("\n")).toEqual([
      "// tigez configuration",
      "diffDrive.setupRadio(55, 114)  // radio channel, group",
      `diffDrive.setupWifi("Busboom_Garage", "${MASKED_PASSWORD}")  // password not known to this computer -- fill it in`,
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)  // wheel diameter 90.68 mm",
    ]);
  });

  it("puts the real password in when revealed, quoting it as a JS string, and is empty with nothing to say", () => {
    expect(
      programCode({ robotName: "t", radio: undefined, wifi: { ssid: "Net", password: 'a"b' }, calibration: {} }),
    ).toContain('diffDrive.setupWifi("Net", "a\\"b")');
    expect(programCode({ robotName: "t", radio: undefined, wifi: undefined, calibration: {} })).toBe("");
  });

  describe("calling it the way CalibrationPage does: a calStore fallback and no splice-header duplication", () => {
    it("forwards calStore/firmwareProfile to calibrationCode so a robot's own stored calibration still fills in", () => {
      const code = programCode({
        robotName: "gopiv",
        radio: undefined,
        wifi: undefined,
        calibration: {},
        calibrationOptions: {
          calStore: { hasWheel: true, hasTurn: false, wheelCalib: 0.7912, trackWidthCm: 0, slip: 1, liveTrackWidthCm: 11.5, liveSlip: 1 },
          firmwareProfile: "calibration-0.20260919.4",
        },
      });
      expect(code).toContain("stored on the robot (calshow)");
    });

    it("includes radio + WiFi alongside calStore-derived calibration lines -- the Calibration tab's full block, one header only", () => {
      const code = programCode({
        robotName: "gopiv",
        radio: { channel: 1, group: 1 },
        wifi: { ssid: "Busboom_Garage", password: undefined },
        calibration: {},
        calibrationOptions: {
          calStore: { hasWheel: false, hasTurn: false, wheelCalib: 0, trackWidthCm: 0, slip: 0, liveTrackWidthCm: 11.5, liveSlip: 1 },
          firmwareProfile: null,
        },
      });
      expect(code.split("\n")[0]).toBe("// gopiv configuration");
      // calibrationCode's own header ("// gopiv calibration") must not
      // survive the splice -- exactly one header line in the output.
      expect(code.match(/^\/\//gm)).toHaveLength(1);
      expect(code).toContain("diffDrive.setupRadio(1, 1)");
      expect(code).toContain(`diffDrive.setupWifi("Busboom_Garage", "${MASKED_PASSWORD}")`);
      expect(code).toContain("NOT measured");
    });

    it("omitting calibrationOptions entirely (ConfigurationPage's own call shape) never invents a calStore fallback line", () => {
      const code = programCode({
        robotName: "tigez",
        radio: { channel: 1, group: 1 },
        wifi: undefined,
        calibration: {},
      });
      expect(code).not.toContain("NOT measured");
      expect(code).not.toContain("calshow");
    });
  });
});
