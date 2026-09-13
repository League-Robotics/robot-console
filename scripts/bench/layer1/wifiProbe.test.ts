import { describe, expect, it } from "vitest";
import { classifyWifiHelloReply, isDebugLine } from "./wifiProbe.js";

describe("isDebugLine", () => {
  it("recognizes DBG:wifi chatter", () => {
    expect(isDebugLine("DBG:wifi rssi=-52")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDebugLine("dbg:wifi anything")).toBe(true);
  });

  it("does not flag real protocol lines", () => {
    expect(isDebugLine("device NEZHA2 robot gopiv 1229577950")).toBe(false);
    expect(isDebugLine("id diffdrive tovez 1.20260912.8 gopiv")).toBe(false);
  });
});

describe("classifyWifiHelloReply", () => {
  it("classifies a real banner", () => {
    const outcome = classifyWifiHelloReply("device NEZHA2 robot gopiv 1229577950");
    expect(outcome.kind).toBe("banner");
    if (outcome.kind === "banner") {
      expect(outcome.banner.name).toBe("gopiv");
    }
  });

  it("classifies undefined as a timeout", () => {
    expect(classifyWifiHelloReply(undefined)).toEqual({ kind: "timeout" });
  });

  it("classifies an unrecognized line as unparsed", () => {
    expect(classifyWifiHelloReply("not a banner")).toEqual({ kind: "unparsed", line: "not a banner" });
  });
});
