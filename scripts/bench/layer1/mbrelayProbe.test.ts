import { describe, expect, it } from "vitest";
import { classifyRadioSweepReply, parseRadioPassthroughReply } from "./mbrelayProbe.js";

describe("parseRadioPassthroughReply", () => {
  it("strips the '< ' pass-through prefix", () => {
    expect(parseRadioPassthroughReply("< device NEZHA2 robot vevov 1198504156")).toBe(
      "device NEZHA2 robot vevov 1198504156",
    );
  });

  it("tolerates a '<' with no following space", () => {
    expect(parseRadioPassthroughReply("<device NEZHA2 robot gopiv 1229577950")).toBe(
      "device NEZHA2 robot gopiv 1229577950",
    );
  });

  it("returns null for a line with no '<' prefix", () => {
    expect(parseRadioPassthroughReply("# channel: 37 group: 43 mode: RAW250 power: 7")).toBeNull();
  });
});

describe("classifyRadioSweepReply", () => {
  it("passes when the pass-through banner names the expected robot (vevov, live-verified reachable)", () => {
    const result = classifyRadioSweepReply("vevov", "< device NEZHA2 robot vevov 1198504156");
    expect(result.status).toBe("pass");
  });

  it("passes for gopiv the same way", () => {
    const result = classifyRadioSweepReply("gopiv", "< device NEZHA2 robot gopiv 1229577950");
    expect(result.status).toBe("pass");
  });

  it("fails on a timeout (no reply) -- the expected shape for tovez/tigez via torture per this sprint's Scope", () => {
    const result = classifyRadioSweepReply("tovez", undefined);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("timeout");
  });

  it("fails when the banner names a different robot than expected", () => {
    const result = classifyRadioSweepReply("tigez", "< device NEZHA2 robot vevov 1198504156");
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("vevov");
  });

  it("fails when the reply isn't pass-through shaped at all", () => {
    const result = classifyRadioSweepReply("vevov", "some unrelated chatter");
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("pass-through shape");
  });
});
