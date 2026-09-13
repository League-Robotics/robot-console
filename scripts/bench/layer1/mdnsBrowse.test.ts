import { describe, expect, it } from "vitest";
import { parseRegistryPort, wifiNameFromTxt } from "./mdnsBrowse.js";

describe("parseRegistryPort", () => {
  it("parses a real captured TXT registry field (torture, 2026-09-13 bench)", () => {
    expect(parseRegistryPort("8761")).toBe(8761);
  });

  it("returns undefined for an absent field", () => {
    expect(parseRegistryPort(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-digit value", () => {
    expect(parseRegistryPort("abc")).toBeUndefined();
  });

  it("returns undefined for an out-of-range port", () => {
    expect(parseRegistryPort("70000")).toBeUndefined();
    expect(parseRegistryPort("0")).toBeUndefined();
  });
});

describe("wifiNameFromTxt", () => {
  it("prefers TXT name over the instance string (gopiv, 2026-09-13 bench)", () => {
    expect(wifiNameFromTxt({ name: "gopiv robot link", txt: { name: "gopiv", role: "robot", link: "v6" } })).toBe(
      "gopiv",
    );
  });

  it("falls back to the instance name when TXT is absent", () => {
    expect(wifiNameFromTxt({ name: "gopiv robot link" })).toBe("gopiv robot link");
  });
});
