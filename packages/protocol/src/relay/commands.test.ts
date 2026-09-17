import { describe, expect, it } from "vitest";
import {
  buildEchoOffLine,
  buildGoLine,
  buildModeRaw250Line,
  buildQueryLine,
  buildRadioSendLine,
  buildSetChannelGroupLine,
  buildSetPowerLine,
  buildTransientChannelGroupLine,
  classifyRelayReply,
  hasTransientTuneCapability,
  parseRadioIdReply,
  parseRelayCapabilities,
  parseRelayStatusLine,
  relayPreambleSteps,
  RelayCommandError,
  validateFrameSize,
  type FrameSizeResult,
} from "./commands.js";
import * as commands from "./commands.js";

describe("relay command-plane line-builders", () => {
  it("builds the exact !ECHO OFF wire text", () => {
    expect(buildEchoOffLine()).toBe("!ECHO OFF\n");
  });

  it("builds the exact !MODE RAW250 wire text", () => {
    expect(buildModeRaw250Line()).toBe("!MODE RAW250\n");
  });

  it("builds the exact !CG <ch> <grp> wire text", () => {
    expect(buildSetChannelGroupLine(47, 60)).toBe("!CG 47 60\n");
    expect(buildSetChannelGroupLine(25, 1)).toBe("!CG 25 1\n");
  });

  it("rejects a non-integer channel/group with RelayCommandError", () => {
    expect(() => buildSetChannelGroupLine(47.5, 60)).toThrow(RelayCommandError);
    expect(() => buildSetChannelGroupLine(47, NaN)).toThrow(RelayCommandError);
  });

  // A tune accepts any hardware-valid pair, not only name-derived ones:
  // during the fleet's move to the 73-channel map, robots are pinned to
  // their old pairs, and overrides can be anything in range.
  const acceptedPairs: ReadonlyArray<readonly [number, number, string]> = [
    [37, 43, "old-map pair (vevov before reflash)"],
    [55, 108, "old-map pair (tovez before reflash)"],
    [48, 29, "new-map pair (tovez)"],
    [20, 82, "new-map pair (vevov)"],
    [0, 0, "hardware minimum"],
    [83, 255, "hardware maximum"],
    [0, 10, "the relay's idle tuning"],
  ];
  const rejectedPairs: ReadonlyArray<readonly [number, number, string]> = [
    [84, 60, "channel above 83"],
    [-1, 60, "negative channel"],
    [47, 256, "group above 255"],
    [47, -1, "negative group"],
    [47.5, 60, "non-integer channel"],
    [47, 60.5, "non-integer group"],
    [NaN, 60, "NaN channel"],
  ];

  for (const [build, verb] of [
    [buildSetChannelGroupLine, "!CG"],
    [buildTransientChannelGroupLine, "!CGT"],
  ] as const) {
    for (const [channel, group, why] of acceptedPairs) {
      it(`${verb} accepts ${channel}/${group}: ${why}`, () => {
        expect(build(channel, group)).toBe(`${verb} ${channel} ${group}\n`);
      });
    }
    for (const [channel, group, why] of rejectedPairs) {
      it(`${verb} rejects ${channel}/${group}: ${why}`, () => {
        expect(() => build(channel, group)).toThrow(RelayCommandError);
      });
    }
  }

  it("names the hardware range in the rejection message", () => {
    expect(() => buildSetChannelGroupLine(84, 60)).toThrow(/channel must be 0-83 and group 0-255/);
  });

  it("builds the exact !CGT <ch> <grp> wire text (rearch-12 transient tune)", () => {
    expect(buildTransientChannelGroupLine(47, 60)).toBe("!CGT 47 60\n");
  });

  it("builds the exact '> <text>' wire text for a one-shot radio send", () => {
    expect(buildRadioSendLine("ID")).toBe("> ID\n");
  });

  it("refuses an empty or newline-containing radio-send text", () => {
    expect(() => buildRadioSendLine("")).toThrow(RelayCommandError);
    expect(() => buildRadioSendLine("a\nb")).toThrow(RelayCommandError);
  });

  it("builds the exact !P 7 wire text", () => {
    expect(buildSetPowerLine()).toBe("!P 7\n");
  });

  it("builds the exact !GO wire text", () => {
    expect(buildGoLine()).toBe("!GO\n");
  });

  it("builds the exact ? wire text", () => {
    expect(buildQueryLine()).toBe("?\n");
  });
});

describe("no PING_LINE/STATUS_LINE dead exports, no HELLO line-builder", () => {
  it("exports no PING_LINE/STATUS_LINE (dead code, removed -- ticket 014-004)", () => {
    const exportNames = Object.keys(commands);
    expect(exportNames).not.toContain("PING_LINE");
    expect(exportNames).not.toContain("STATUS_LINE");
  });

  it("exports no HELLO line-builder at all", () => {
    const exportNames = Object.keys(commands);
    const helloLike = exportNames.filter((name) => /hello/i.test(name));
    expect(helloLike).toEqual([]);

    // Belt-and-suspenders: no exported function, called with no
    // arguments, ever returns a line whose verb is HELLO -- guards
    // against a HELLO builder existing under a name this regex missed.
    for (const name of exportNames) {
      const value = (commands as unknown as Record<string, unknown>)[name];
      if (typeof value !== "function") {
        continue;
      }
      let result: unknown;
      try {
        result = (value as () => unknown)();
      } catch {
        continue; // a builder that requires arguments (e.g. buildSetChannelGroupLine) throws with none -- not a HELLO builder either way
      }
      if (typeof result === "string") {
        expect(result.startsWith("HELLO")).toBe(false);
      }
    }
  });
});

describe("validateFrameSize", () => {
  it("accepts a MAKECODE payload exactly at the 16-byte cap", () => {
    const result = validateFrameSize("makecode", 16);
    expect(result).toEqual<FrameSizeResult>({ ok: true });
  });

  it("refuses a MAKECODE payload one byte over the 16-byte cap", () => {
    const result = validateFrameSize("makecode", 17);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/makecode/i);
      expect(result.reason).toMatch(/17/);
      expect(result.reason).toMatch(/16/);
    }
  });

  it("accepts a RAW250 payload exactly at the 247-byte cap", () => {
    const result = validateFrameSize("raw250", 247);
    expect(result).toEqual<FrameSizeResult>({ ok: true });
  });

  it("refuses a RAW250 payload one byte over the 247-byte cap", () => {
    const result = validateFrameSize("raw250", 248);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/raw250/i);
      expect(result.reason).toMatch(/248/);
      expect(result.reason).toMatch(/247/);
    }
  });

  it("never throws on an oversized payload -- returns a refusal value instead", () => {
    expect(() => validateFrameSize("makecode", 1_000_000)).not.toThrow();
    expect(() => validateFrameSize("raw250", 1_000_000)).not.toThrow();
  });

  it("accepts a well-under-cap payload for both modes", () => {
    expect(validateFrameSize("makecode", 0)).toEqual<FrameSizeResult>({ ok: true });
    expect(validateFrameSize("raw250", 0)).toEqual<FrameSizeResult>({ ok: true });
  });
});

describe("parseRelayStatusLine", () => {
  it("parses the live-captured status line", () => {
    expect(parseRelayStatusLine("# channel: 47 group: 60 mode: RAW250 power: 7")).toEqual({
      channel: 47,
      group: 60,
      mode: "RAW250",
      power: 7,
    });
  });

  it("tolerates leading whitespace", () => {
    expect(parseRelayStatusLine("  # channel: 25 group: 1 mode: RAW250 power: 7")).toEqual({
      channel: 25,
      group: 1,
      mode: "RAW250",
      power: 7,
    });
  });

  it("returns null for a non-status line", () => {
    expect(parseRelayStatusLine("# echo: OFF")).toBeNull();
    expect(parseRelayStatusLine("# entering data plane")).toBeNull();
    expect(parseRelayStatusLine("not a relay reply at all")).toBeNull();
  });

  it("returns null for a status-shaped line missing a field", () => {
    expect(parseRelayStatusLine("# channel: 47 group: 60")).toBeNull();
  });
});

describe("parseRelayCapabilities (rearch-12, League-Robotics/microbit-radio-relay#1 -- merged: `caps: CGT`)", () => {
  it("parses the trailing caps: field off a full status line", () => {
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT")).toEqual({
      tokens: ["CGT"],
    });
  });

  it("is case-insensitive on both the 'caps:' label and the token itself", () => {
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 CAPS: cgt")).toEqual({
      tokens: ["CGT"],
    });
  });

  it("returns null when the line has no caps: field at all (older firmware)", () => {
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7")).toBeNull();
    expect(parseRelayCapabilities("# echo: OFF")).toBeNull();
    expect(parseRelayCapabilities("not a relay reply at all")).toBeNull();
  });

  it("returns null for a caps: field with nothing after it -- never guesses at a partial parse", () => {
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 caps:")).toBeNull();
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 caps: ")).toBeNull();
  });

  it("parses multiple tokens, whitespace- or comma-separated, in case a future firmware advertises more than one", () => {
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT TX")).toEqual({
      tokens: ["CGT", "TX"],
    });
    expect(parseRelayCapabilities("# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT,TX")).toEqual({
      tokens: ["CGT", "TX"],
    });
  });
});

describe("hasTransientTuneCapability", () => {
  it("is true when the caps: field includes CGT", () => {
    expect(hasTransientTuneCapability("# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT")).toBe(true);
  });

  it("is false when caps: is present but does not include CGT", () => {
    expect(hasTransientTuneCapability("# channel: 47 group: 60 mode: RAW250 power: 7 caps: TX")).toBe(false);
  });

  it("is false when the line has no caps: field at all (older firmware defaults off)", () => {
    expect(hasTransientTuneCapability("# channel: 47 group: 60 mode: RAW250 power: 7")).toBe(false);
  });
});

describe("classifyRelayReply", () => {
  it("classifies a full status line as 'status'", () => {
    expect(classifyRelayReply("# channel: 47 group: 60 mode: RAW250 power: 7")).toBe("status");
  });

  it("classifies '# echo: OFF' as 'echo', not 'status'", () => {
    expect(classifyRelayReply("# echo: OFF")).toBe("echo");
  });

  it("classifies '# mode: RAW250' as 'mode' -- distinct from a full status line", () => {
    expect(classifyRelayReply("# mode: RAW250")).toBe("mode");
  });

  it("classifies '# entering data plane' as 'enteringDataPlane'", () => {
    expect(classifyRelayReply("# entering data plane")).toBe("enteringDataPlane");
  });

  it("classifies '# error: ...' as 'error'", () => {
    expect(classifyRelayReply("# error: usage !CG <ch 0-83> <group 0-255>")).toBe("error");
  });

  it("classifies any other '#'-prefixed line as 'comment'", () => {
    expect(classifyRelayReply("# micro:bit radio relay")).toBe("comment");
    expect(classifyRelayReply("# Relay v0.20260907.1 -- commands: !CG !GO !P")).toBe("comment");
  });

  it("classifies a non-'#' line as 'other'", () => {
    expect(classifyRelayReply("DBG:wifi state=1 ip=-")).toBe("other");
    expect(classifyRelayReply("STOP #1")).toBe("other");
  });
});

describe("relayPreambleSteps", () => {
  it("returns the five steps in order, with the exact wire lines", () => {
    const steps = relayPreambleSteps(37, 3);
    expect(steps.map((s) => s.line)).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      "!CG 37 3\n",
      "!P 7\n",
      "!GO\n",
    ]);
    expect(steps.map((s) => s.label)).toEqual(["!ECHO OFF", "!MODE RAW250", "!CG 37 3", "!P 7", "!GO"]);
  });

  it("each step's confirms() recognizes its own reply and rejects the others' replies", () => {
    const [echoStep, modeStep, cgStep, powerStep, goStep] = relayPreambleSteps(37, 3);
    expect(echoStep!.confirms("# echo: OFF")).toBe(true);
    expect(echoStep!.confirms("# mode: RAW250")).toBe(false);

    expect(modeStep!.confirms("# mode: RAW250")).toBe(true);
    expect(modeStep!.confirms("# echo: OFF")).toBe(false);

    expect(cgStep!.confirms("# channel: 37 group: 3 mode: RAW250 power: 7")).toBe(true);
    expect(cgStep!.confirms("# channel: 99 group: 9 mode: RAW250 power: 7")).toBe(false);

    expect(powerStep!.confirms("# channel: 37 group: 3 mode: RAW250 power: 7")).toBe(true);
    expect(powerStep!.confirms("# channel: 37 group: 3 mode: RAW250 power: 3")).toBe(false);

    expect(goStep!.confirms("# entering data plane")).toBe(true);
    expect(goStep!.confirms("# echo: OFF")).toBe(false);
  });

  it("range-checks the !CG step's channel/group, same as buildSetChannelGroupLine", () => {
    expect(() => relayPreambleSteps(84, 3)).toThrow(RelayCommandError);
    expect(() => relayPreambleSteps(37, 256)).toThrow(RelayCommandError);
  });
});

// ---------------------------------------------------------------------
// parseRadioIdReply -- sprint 016 ticket 003's own probe-reply parser,
// reusing deviceType.ts's existing parseIdReply for the payload grammar
// itself (see this function's own doc comment for why).
// ---------------------------------------------------------------------

describe("parseRadioIdReply", () => {
  it("parses a relay-delivered '< id ...' line into its four fields", () => {
    expect(parseRadioIdReply("< id diffdrive vevov 1.0.10 vevov")).toEqual({
      product: "diffdrive",
      program: "vevov",
      version: "1.0.10",
      name: "vevov",
    });
  });

  it("tolerates no space after the '<' receive prefix", () => {
    expect(parseRadioIdReply("<id diffdrive vevov 1.0.10 vevov")).toEqual({
      product: "diffdrive",
      program: "vevov",
      version: "1.0.10",
      name: "vevov",
    });
  });

  it("matches the ID verb case-insensitively", () => {
    expect(parseRadioIdReply("< ID diffdrive vevov 1.0.10 vevov")?.name).toBe("vevov");
  });

  it("returns null for a line with no '<' receive prefix at all -- a bare v6 ID reply is not something a relay's command plane ever delivers this way", () => {
    expect(parseRadioIdReply("id diffdrive vevov 1.0.10 vevov")).toBeNull();
  });

  it("returns null for a delivered line whose verb is not 'id'", () => {
    expect(parseRadioIdReply("< status pending 0 none")).toBeNull();
  });

  it("returns null for a delivered 'id' line with too few fields", () => {
    expect(parseRadioIdReply("< id diffdrive vevov")).toBeNull();
  });

  it("returns null for an unrelated relay comment line", () => {
    expect(parseRadioIdReply("# channel: 47 group: 60 mode: RAW250 power: 7")).toBeNull();
  });
});
