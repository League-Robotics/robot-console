import { describe, expect, it } from "vitest";
import { classifyConnectError, classifyMbserialHelloReply } from "./mbserialProbe.js";

describe("classifyMbserialHelloReply", () => {
  it("classifies a real banner reply", () => {
    const outcome = classifyMbserialHelloReply("device NEZHA2 robot gopiv 1229577950");
    expect(outcome.kind).toBe("banner");
    if (outcome.kind === "banner") {
      expect(outcome.banner.name).toBe("gopiv");
      expect(outcome.banner.role).toBe("NEZHA2");
    }
  });

  it("classifies 'ERR busy' distinctly from a timeout", () => {
    expect(classifyMbserialHelloReply("ERR busy")).toEqual({ kind: "busy" });
    expect(classifyMbserialHelloReply("ERR busy ")).toEqual({ kind: "busy" });
  });

  it("classifies a case-insensitive busy reply", () => {
    expect(classifyMbserialHelloReply("err BUSY")).toEqual({ kind: "busy" });
  });

  it("classifies undefined (nothing arrived within the bound) as a timeout, never as busy", () => {
    expect(classifyMbserialHelloReply(undefined)).toEqual({ kind: "timeout" });
  });

  it("classifies an unrecognized line as unparsed, not a silent pass", () => {
    expect(classifyMbserialHelloReply("garbage")).toEqual({ kind: "unparsed", line: "garbage" });
  });
});

describe("classifyConnectError", () => {
  it("recognizes ECONNREFUSED as refused", () => {
    expect(classifyConnectError("connect ECONNREFUSED 192.168.1.50:36627")).toBe("refused");
  });

  it("recognizes this module's own connect-timeout message", () => {
    expect(classifyConnectError("connect to 192.168.1.50:36627 timed out after 5000ms")).toBe("timeout");
  });

  it("buckets anything else as other", () => {
    expect(classifyConnectError("getaddrinfo ENOTFOUND loki.local")).toBe("other");
  });
});
