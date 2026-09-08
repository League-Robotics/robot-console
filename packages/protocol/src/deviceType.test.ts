import { describe, expect, it } from "vitest";
import { classifyBanner, normalizeDeviceType } from "./deviceType.js";
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

  it("coerces 'unknown' to 'unknown'", () => {
    expect(normalizeDeviceType("unknown")).toBe("unknown");
  });

  it("coerces a fabricated future value to 'unknown'", () => {
    expect(normalizeDeviceType("calibration")).toBe("unknown");
  });

  it("coerces an empty string to 'unknown'", () => {
    expect(normalizeDeviceType("")).toBe("unknown");
  });
});
