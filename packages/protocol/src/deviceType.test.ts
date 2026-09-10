import { describe, expect, it } from "vitest";
import { classifyBanner, normalizeDeviceType, parseIdReply, refineForCalibration } from "./deviceType.js";
import type { DeviceClassification } from "./deviceType.js";
import type { ParsedBanner } from "./banner.js";

function banner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
  return {
    role: "RADIOBRIDGE",
    commonName: "relay",
    name: "abcde",
    serial: 123,
    dialect: "colon",
    ...overrides,
  };
}

describe("classifyBanner", () => {
  it("classifies no banner as unknown with evidence 'none' and every field null", () => {
    expect(classifyBanner(null)).toEqual({
      type: "unknown",
      role: null,
      commonName: null,
      dialect: null,
      evidence: "none",
      program: null,
      version: null,
    });
  });

  it("classifies commonName 'relay' as relay, evidence 'common-name'", () => {
    const result = classifyBanner(banner({ commonName: "relay", role: "SOMETHING-ELSE" }));
    expect(result).toEqual({
      type: "relay",
      role: "SOMETHING-ELSE",
      commonName: "relay",
      dialect: "colon",
      evidence: "common-name",
      program: null,
      version: null,
    });
  });

  it("classifies commonName 'robot' as robot, evidence 'common-name'", () => {
    const result = classifyBanner(banner({ commonName: "robot", role: "SOMETHING-ELSE" }));
    expect(result.type).toBe("robot");
    expect(result.evidence).toBe("common-name");
  });

  it("matches commonName case-insensitively", () => {
    expect(classifyBanner(banner({ commonName: "RELAY" })).type).toBe("relay");
    expect(classifyBanner(banner({ commonName: "Robot" })).type).toBe("robot");
  });

  it("falls back to the role allowlist when commonName doesn't match: RADIORELAY -> relay", () => {
    const result = classifyBanner(banner({ commonName: "widget", role: "RADIORELAY" }));
    expect(result).toEqual({
      type: "relay",
      role: "RADIORELAY",
      commonName: "widget",
      dialect: "colon",
      evidence: "role",
      program: null,
      version: null,
    });
  });

  it("falls back to the role allowlist when commonName doesn't match: RADIOBRIDGE -> relay", () => {
    const result = classifyBanner(banner({ commonName: "widget", role: "RADIOBRIDGE" }));
    expect(result.type).toBe("relay");
    expect(result.evidence).toBe("role");
  });

  it("falls back to the role allowlist when commonName doesn't match: NEZHA2 -> robot", () => {
    const result = classifyBanner(banner({ commonName: "widget", role: "NEZHA2", dialect: "space" }));
    expect(result).toEqual({
      type: "robot",
      role: "NEZHA2",
      commonName: "widget",
      dialect: "space",
      evidence: "role",
      program: null,
      version: null,
    });
  });

  it("commonName takes precedence over a role that would otherwise match a different type", () => {
    // role says NEZHA2 (robot) but commonName explicitly says relay --
    // commonName wins per the module's stated precedence.
    const result = classifyBanner(banner({ commonName: "relay", role: "NEZHA2" }));
    expect(result.type).toBe("relay");
    expect(result.evidence).toBe("common-name");
  });

  it("classifies an unrecognized commonName AND an unrecognized role together as unknown, preserving both verbatim", () => {
    const result = classifyBanner(
      banner({ commonName: "widget", role: "ROBOTV7", dialect: "space" }),
    );
    expect(result).toEqual({
      type: "unknown",
      role: "ROBOTV7",
      commonName: "widget",
      dialect: "space",
      evidence: "unrecognized",
      program: null,
      version: null,
    });
  });
});

describe("normalizeDeviceType", () => {
  it("passes through 'relay'", () => {
    expect(normalizeDeviceType("relay")).toBe("relay");
  });

  it("passes through 'robot'", () => {
    expect(normalizeDeviceType("robot")).toBe("robot");
  });

  it("passes through 'calibration' (sprint 011 ticket 001 -- no longer a fabricated future value)", () => {
    expect(normalizeDeviceType("calibration")).toBe("calibration");
  });

  it("coerces 'unknown' to 'unknown'", () => {
    expect(normalizeDeviceType("unknown")).toBe("unknown");
  });

  it("coerces a fabricated future value to 'unknown'", () => {
    expect(normalizeDeviceType("some-fifth-type")).toBe("unknown");
  });

  it("coerces an empty string to 'unknown'", () => {
    expect(normalizeDeviceType("")).toBe("unknown");
  });
});

describe("parseIdReply", () => {
  it("parses a well-formed id reply's four positional fields", () => {
    expect(parseIdReply(["diffdrive", "calibration-0.20260907.2", "1.20260907.5", "gopiv"])).toEqual({
      product: "diffdrive",
      program: "calibration-0.20260907.2",
      version: "1.20260907.5",
      name: "gopiv",
    });
  });

  it("parses a plain student-build program the same way", () => {
    expect(parseIdReply(["diffdrive", "tovez", "1.20260905.1", "zavaz"])).toEqual({
      product: "diffdrive",
      program: "tovez",
      version: "1.20260905.1",
      name: "zavaz",
    });
  });

  it("returns null when fewer than four fields are present", () => {
    expect(parseIdReply([])).toBeNull();
    expect(parseIdReply(["diffdrive"])).toBeNull();
    expect(parseIdReply(["diffdrive", "tovez", "1.20260905.1"])).toBeNull();
  });
});

describe("refineForCalibration", () => {
  function robotClassification(overrides: Partial<DeviceClassification> = {}): DeviceClassification {
    return {
      type: "robot",
      role: "NEZHA2",
      commonName: "robot",
      dialect: "space",
      evidence: "role",
      program: null,
      version: null,
      ...overrides,
    };
  }

  it("narrows type to 'calibration' when program matches the calibration- prefix", () => {
    const result = refineForCalibration(robotClassification(), {
      product: "diffdrive",
      program: "calibration-0.20260907.2",
      version: "1.20260907.5",
      name: "gopiv",
    });
    expect(result.type).toBe("calibration");
    expect(result.program).toBe("calibration-0.20260907.2");
    expect(result.version).toBe("1.20260907.5");
    // Every other field is preserved verbatim from the input classification.
    expect(result.role).toBe("NEZHA2");
    expect(result.evidence).toBe("role");
  });

  it("leaves type at 'robot' for any other program value, preserving program/version for diagnostics", () => {
    const result = refineForCalibration(robotClassification(), {
      product: "diffdrive",
      program: "tovez",
      version: "1.20260905.1",
      name: "zavaz",
    });
    expect(result.type).toBe("robot");
    expect(result.program).toBe("tovez");
    expect(result.version).toBe("1.20260905.1");
  });

  it("does not match a program that merely resembles the prefix without it (e.g. 'calib-test')", () => {
    const result = refineForCalibration(robotClassification(), {
      product: "diffdrive",
      program: "calib-test",
      version: "0.0.1",
      name: "zzzzz",
    });
    expect(result.type).toBe("robot");
  });

  it("never narrows a non-'robot' classification to 'calibration', even given a matching program", () => {
    const relay = refineForCalibration(robotClassification({ type: "relay" }), {
      product: "diffdrive",
      program: "calibration-0.20260907.2",
      version: "1.20260907.5",
      name: "gopiv",
    });
    expect(relay.type).toBe("relay");
  });
});
