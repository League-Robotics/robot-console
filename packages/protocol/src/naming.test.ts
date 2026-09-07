import { describe, expect, it } from "vitest";
import { NAME_SPACE, deviceIdToName, nameToValue } from "./naming.js";

describe("deviceIdToName", () => {
  it("matches the worked example from mbdeploy's devices.py docstring", () => {
    // mbdeploy/src/mbdeploy/devices.py:205-218, friendly_name() docstring.
    expect(deviceIdToName(2314287040)).toBe("tovez");
  });

  it("produces only well-formed CVCVC names", () => {
    const pattern = /^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/;
    for (const deviceId of [0, 1, 3124, 3125, 4294967295, 1198504156]) {
      expect(deviceIdToName(deviceId)).toMatch(pattern);
    }
  });
});

describe("nameToValue", () => {
  it("rejects malformed names", () => {
    for (const bad of ["gauti", "vevo", "vevovv", "aeiou", "", "TOVEZZ"]) {
      expect(() => nameToValue(bad)).toThrow();
    }
  });
});

describe("round-trip: deviceIdToName then nameToValue", () => {
  // deviceIdToName and nameToValue are independently-written (the
  // latter is not derived from the former — see the comment on
  // nameToValue in naming.ts), so agreeing here is a real check, not
  // a tautology. Exercise the entire 3125-name space: for any id in
  // [0, NAME_SPACE), the name only ever encodes that id's low 5
  // base-5 digits, so id -> name -> id must round-trip exactly.
  it("round-trips every id in [0, 3124]", () => {
    for (let id = 0; id < NAME_SPACE; id++) {
      const name = deviceIdToName(id);
      expect(nameToValue(name)).toBe(id);
    }
  });

  it("round-trips a full 32-bit chip id modulo the name space", () => {
    const deviceId = 2314287040;
    const name = deviceIdToName(deviceId);
    expect(nameToValue(name)).toBe(deviceId % NAME_SPACE);
  });
});
