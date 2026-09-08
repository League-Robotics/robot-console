import { describe, expect, it } from "vitest";
import {
  buildEchoOffLine,
  buildGoLine,
  buildModeRaw250Line,
  buildQueryLine,
  buildSetChannelGroupLine,
  buildSetPowerLine,
  PING_LINE,
  RelayCommandError,
  STATUS_LINE,
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

describe("liveness pair (PING/STATUS), exported as data", () => {
  it("PING_LINE is the exact wire text Session.checkLiveness() sends", () => {
    expect(PING_LINE).toBe("PING\n");
  });

  it("STATUS_LINE is the exact unsequenced STATUS wire text", () => {
    expect(STATUS_LINE).toBe("STATUS\n");
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
