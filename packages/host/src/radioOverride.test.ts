/**
 * radioOverride.test.ts — sprint 015 ticket 006's own suite: the
 * `isValidRadioOverride` range check, and `resolveDeviceRadio`'s
 * `override -> registry -> derived` order, driven with a fake registry
 * lookup so no live mbrelay is ever required (this ticket's own
 * acceptance criterion).
 */
import { describe, expect, it, vi } from "vitest";
import { isValidRadioOverride, resolveDeviceRadio, RADIO_CHANNEL_MAX, RADIO_CHANNEL_MIN, RADIO_GROUP_MAX, RADIO_GROUP_MIN } from "./radioOverride.js";
import type { ResolvedAddress } from "./mbrelayRegistry.js";

describe("isValidRadioOverride", () => {
  it("accepts the boundary values of both ranges", () => {
    expect(isValidRadioOverride(RADIO_CHANNEL_MIN, RADIO_GROUP_MIN)).toBe(true);
    expect(isValidRadioOverride(RADIO_CHANNEL_MAX, RADIO_GROUP_MAX)).toBe(true);
    expect(isValidRadioOverride(41, 3)).toBe(true);
  });

  it("rejects a channel outside 0-83", () => {
    expect(isValidRadioOverride(-1, 3)).toBe(false);
    expect(isValidRadioOverride(84, 3)).toBe(false);
  });

  it("rejects a group outside 0-255", () => {
    expect(isValidRadioOverride(41, -1)).toBe(false);
    expect(isValidRadioOverride(41, 256)).toBe(false);
  });

  it("rejects a non-integer channel or group", () => {
    expect(isValidRadioOverride(41.5, 3)).toBe(false);
    expect(isValidRadioOverride(41, 3.5)).toBe(false);
    expect(isValidRadioOverride(Number.NaN, 3)).toBe(false);
  });
});

describe("resolveDeviceRadio", () => {
  it("resolves to the stored override ahead of the registry or derived default, without ever consulting the registry", async () => {
    const resolveRegistry = vi.fn();
    const result = await resolveDeviceRadio(
      "vevov",
      { radioChannel: 41, radioGroup: 3, radioSource: "override" },
      { resolveRegistry },
    );
    expect(result).toEqual({ channel: 41, group: 3, source: "override" });
    expect(resolveRegistry).not.toHaveBeenCalled();
  });

  it("consults the registry when there is no override, mapping a 'registry' outcome to source 'registry'", async () => {
    const resolveRegistry = vi.fn(
      async (): Promise<ResolvedAddress> => ({ channel: 27, group: 5, outcome: "registry" }),
    );
    const result = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: null }, { resolveRegistry });
    expect(result).toEqual({ channel: 27, group: 5, source: "registry" });
  });

  it("maps a 'config' registry outcome to source 'registry' too (the DB/wire have no separate 'config' slot)", async () => {
    const resolveRegistry = vi.fn(
      async (): Promise<ResolvedAddress> => ({ channel: 29, group: 7, outcome: "config" }),
    );
    const result = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: null }, { resolveRegistry });
    expect(result).toEqual({ channel: 29, group: 7, source: "registry" });
  });

  it("maps 'derived'/'local-derived' registry outcomes to source 'derived'", async () => {
    const derived = vi.fn(async (): Promise<ResolvedAddress> => ({ channel: 33, group: 2, outcome: "derived" }));
    const localDerived = vi.fn(async (): Promise<ResolvedAddress> => ({ channel: 33, group: 2, outcome: "local-derived" }));

    const a = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: null }, { resolveRegistry: derived });
    const b = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: null }, { resolveRegistry: localDerived });

    expect(a).toEqual({ channel: 33, group: 2, source: "derived" });
    expect(b).toEqual({ channel: 33, group: 2, source: "derived" });
  });

  it("consults the registry when radioSource is 'registry' but the columns are incomplete (defensive -- should not happen in practice)", async () => {
    const resolveRegistry = vi.fn(async (): Promise<ResolvedAddress> => ({ channel: 45, group: 9, outcome: "derived" }));
    const result = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: "registry" }, { resolveRegistry });
    expect(result).toEqual({ channel: 45, group: 9, source: "derived" });
    expect(resolveRegistry).toHaveBeenCalled();
  });

  it("falls back to the real resolveRobotAddress (local-derived, no registry configured) when resolveRegistry is not injected", async () => {
    const result = await resolveDeviceRadio("vevov", { radioChannel: null, radioGroup: null, radioSource: null });
    // No registry location supplied -> resolveRobotAddress's own
    // "local-derived" path -- this module maps that to "derived".
    expect(result.source).toBe("derived");
    expect(Number.isInteger(result.channel)).toBe(true);
    expect(Number.isInteger(result.group)).toBe(true);
  });
});
