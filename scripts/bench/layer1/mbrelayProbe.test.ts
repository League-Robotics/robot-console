import { describe, expect, it } from "vitest";
import { classifyRadioSweepReplies, classifyRadioSweepReply, isCommandEcho, parseRadioPassthroughReply } from "./mbrelayProbe.js";

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

describe("isCommandEcho", () => {
  it("recognizes a bare HELLO echo", () => {
    expect(isCommandEcho("HELLO")).toBe(true);
  });

  it("recognizes a bare ID echo (018-003 live flake: torture replied '< ID' to a '> HELLO' sweep request)", () => {
    expect(isCommandEcho("ID")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isCommandEcho("  id  ")).toBe(true);
    expect(isCommandEcho("hello")).toBe(true);
  });

  it("does not flag a genuine banner as an echo", () => {
    expect(isCommandEcho("device NEZHA2 robot vevov 1198504156")).toBe(false);
  });

  it("does not flag an id reply line as an echo (it's 'id ...', not the bare word 'ID')", () => {
    expect(isCommandEcho("id diffdrive calibration-0.20260913.1 1.20260912.8 vevov")).toBe(false);
  });
});

describe("classifyRadioSweepReplies (018-003 correlation fix)", () => {
  it("fails on a true timeout -- nothing pass-through-shaped arrived at all", () => {
    const result = classifyRadioSweepReplies("tovez", []);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("timeout");
  });

  it("passes when the only line is a genuine matching banner", () => {
    const result = classifyRadioSweepReplies("vevov", ["device NEZHA2 robot vevov 1198504156"]);
    expect(result.status).toBe("pass");
  });

  it("skips a leading stale echo and passes on the genuine banner behind it (the live 018-003 flake, fixed)", () => {
    const result = classifyRadioSweepReplies("gopiv", ["ID", "device NEZHA2 robot gopiv 1229577950"]);
    expect(result.status).toBe("pass");
    expect(result.reason).toContain("gopiv");
  });

  it("fails distinctly when only a stale echo was ever seen (no genuine banner behind it)", () => {
    const result = classifyRadioSweepReplies("gopiv", ["ID"]);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("stale command echo");
  });

  it("fails when the first genuine line names a different robot", () => {
    const result = classifyRadioSweepReplies("tigez", ["HELLO", "device NEZHA2 robot vevov 1198504156"]);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("vevov");
  });

  it("fails when the first genuine line doesn't parse as a banner at all", () => {
    const result = classifyRadioSweepReplies("vevov", ["some unrelated chatter"]);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("did not parse as a banner");
  });
});
