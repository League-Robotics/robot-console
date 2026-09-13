import { describe, expect, it } from "vitest";
import { FRIENDLY_NAME_PATTERN, namesNeedingWifiLookup } from "./wifiNameLookup.js";

describe("FRIENDLY_NAME_PATTERN", () => {
  it("matches a well-formed five-letter micro:bit name", () => {
    expect(FRIENDLY_NAME_PATTERN.test("gopiv")).toBe(true);
    expect(FRIENDLY_NAME_PATTERN.test("vevov")).toBe(true);
  });

  it("rejects a pool name or a raw USB serial fallback", () => {
    expect(FRIENDLY_NAME_PATTERN.test("torture")).toBe(false);
    expect(FRIENDLY_NAME_PATTERN.test("9906B0000123456")).toBe(false);
  });
});

describe("namesNeedingWifiLookup (018-003 WiFi coverage gap)", () => {
  it("returns every known name not already announced", () => {
    const result = namesNeedingWifiLookup(["gopiv", "vevov", "tigez"], new Set(["vevov"]));
    expect(result).toEqual(["gopiv", "tigez"]);
  });

  it("returns nothing when every known name was already announced", () => {
    const result = namesNeedingWifiLookup(["gopiv", "vevov"], new Set(["gopiv", "vevov"]));
    expect(result).toEqual([]);
  });

  it("filters out names that aren't well-formed five-letter robot names (pool names, raw serials)", () => {
    const result = namesNeedingWifiLookup(["gopiv", "torture", "9906B0000123456"], new Set());
    expect(result).toEqual(["gopiv"]);
  });

  it("de-duplicates the known-names input", () => {
    const result = namesNeedingWifiLookup(["gopiv", "gopiv"], new Set());
    expect(result).toEqual(["gopiv"]);
  });

  it("sorts the result deterministically", () => {
    const result = namesNeedingWifiLookup(["vevov", "gopiv"], new Set());
    expect(result).toEqual(["gopiv", "vevov"]);
  });
});
