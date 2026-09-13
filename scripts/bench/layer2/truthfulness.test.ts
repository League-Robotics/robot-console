import { describe, expect, it } from "vitest";
import {
  assertNoStaleWhileAdvertised,
  assertNoRelayAsRobot,
  assertOneRowPerName,
  runTruthfulnessAssertions,
  type AssertableDevice,
} from "./truthfulness.js";

const link = (over: Partial<AssertableDevice["links"][number]> = {}): AssertableDevice["links"][number] => ({
  id: "link-1",
  transport: "mbserial",
  state: "connected",
  reason: null,
  ...over,
});

describe("assertNoStaleWhileAdvertised", () => {
  it("clean fixture: passes for an advertised device with no stale link", () => {
    const devices: AssertableDevice[] = [{ name: "gopiv", kind: "robot", role: "NEZHA2", links: [link({ state: "connected" })] }];
    const results = assertNoStaleWhileAdvertised(devices, new Set(["gopiv"]));
    expect(results).toEqual([
      {
        assertion: "no-stale-while-advertised",
        device: "gopiv",
        pass: true,
        reason: expect.stringContaining("no stale"),
      },
    ]);
  });

  it("stale-while-advertised fixture: fails when a link is state stale for a currently-advertised device", () => {
    const devices: AssertableDevice[] = [
      { name: "gopiv", kind: "robot", role: "NEZHA2", links: [link({ id: "mbserial-gopiv", state: "stale" })] },
    ];
    const results = assertNoStaleWhileAdvertised(devices, new Set(["gopiv"]));
    expect(results).toHaveLength(1);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.reason).toContain("mbserial-gopiv");
    expect(results[0]?.reason).toContain("stale");
  });

  it("also treats a 'Not seen since ...' reason as stale-like even if state itself is something else", () => {
    const devices: AssertableDevice[] = [
      { name: "vevov", kind: "robot", role: "NEZHA2", links: [link({ id: "wifi-vevov", state: "unresponsive", reason: "Not seen since 12:03" })] },
    ];
    const results = assertNoStaleWhileAdvertised(devices, new Set(["vevov"]));
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.reason).toContain("wifi-vevov");
  });

  it("is silent (no result at all) for a device whose service is not currently advertised, even if genuinely stale", () => {
    const devices: AssertableDevice[] = [{ name: "tovez", kind: "robot", role: "NEZHA2", links: [link({ state: "stale" })] }];
    const results = assertNoStaleWhileAdvertised(devices, new Set(["gopiv"]));
    expect(results).toEqual([]);
  });
});

describe("assertNoRelayAsRobot", () => {
  it("clean fixture: a robot device with a robot role passes", () => {
    const devices: AssertableDevice[] = [{ name: "gopiv", kind: "robot", role: "NEZHA2", links: [] }];
    expect(assertNoRelayAsRobot(devices)).toEqual([
      { assertion: "no-relay-as-robot", device: "gopiv", pass: true, reason: expect.stringContaining("consistent") },
    ]);
  });

  it("relay-as-robot fixture: fails when kind robot but role is a relay banner role", () => {
    const devices: AssertableDevice[] = [{ name: "vitut", kind: "robot", role: "RADIOBRIDGE", links: [] }];
    const results = assertNoRelayAsRobot(devices);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.reason).toContain("vitut");
    expect(results[0]?.reason).toContain("RADIOBRIDGE");
  });

  it("a device correctly recorded kind: relay with a relay role passes", () => {
    const devices: AssertableDevice[] = [{ name: "vitut", kind: "relay", role: "RADIOBRIDGE", links: [] }];
    expect(assertNoRelayAsRobot(devices)[0]?.pass).toBe(true);
  });

  it("a device with role: null (never identified) passes -- nothing to contradict yet", () => {
    const devices: AssertableDevice[] = [{ name: "unknown-board", kind: "robot", role: null, links: [] }];
    expect(assertNoRelayAsRobot(devices)[0]?.pass).toBe(true);
  });
});

describe("assertOneRowPerName", () => {
  it("clean fixture: one row per name passes", () => {
    const devices: AssertableDevice[] = [
      { name: "gopiv", kind: "robot", role: "NEZHA2", links: [] },
      { name: "vevov", kind: "robot", role: "NEZHA2", links: [] },
    ];
    const results = assertOneRowPerName(devices);
    expect(results).toEqual([
      { assertion: "one-row-per-name", device: "gopiv", pass: true, reason: expect.stringContaining("exactly one") },
      { assertion: "one-row-per-name", device: "vevov", pass: true, reason: expect.stringContaining("exactly one") },
    ]);
  });

  it("duplicate-names fixture: fails and reports the count when two rows share a name", () => {
    const devices: AssertableDevice[] = [
      { name: "vevov", kind: "robot", role: "NEZHA2", links: [] },
      { name: "vevov", kind: "relay", role: "RADIOBRIDGE", links: [] },
    ];
    const results = assertOneRowPerName(devices);
    expect(results).toEqual([{ assertion: "one-row-per-name", device: "vevov", pass: false, reason: expect.stringContaining("2 devices rows") }]);
  });
});

describe("runTruthfulnessAssertions", () => {
  it("concatenates all three assertions' per-device results in order", () => {
    const devices: AssertableDevice[] = [{ name: "gopiv", kind: "robot", role: "NEZHA2", links: [link({ state: "connected" })] }];
    const results = runTruthfulnessAssertions(devices, new Set(["gopiv"]));
    expect(results.map((r) => r.assertion)).toEqual(["no-stale-while-advertised", "no-relay-as-robot", "one-row-per-name"]);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("the fully clean fixture: every assertion passes for a normal, non-duplicated, correctly-kinded, non-stale device set", () => {
    const devices: AssertableDevice[] = [
      { name: "gopiv", kind: "robot", role: "NEZHA2", links: [link({ id: "mbserial-gopiv", state: "connected" })] },
      { name: "vitut", kind: "relay", role: "RADIOBRIDGE", links: [link({ id: "usb-vitut", state: "connected" })] },
    ];
    const results = runTruthfulnessAssertions(devices, new Set(["gopiv"]));
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
