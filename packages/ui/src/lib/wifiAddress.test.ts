import { describe, expect, it } from "vitest";
import { defaultWifiAddress, deriveRobotWifiAddress, parseWifiAddress } from "./wifiAddress";

describe("wifiAddress", () => {
  it("derives 10.55.<group>.<channel> from a robot name and nothing from any other text", () => {
    expect(defaultWifiAddress("tovez")).toBe("10.55.29.48");
    expect(defaultWifiAddress("vevov")).toBe("10.55.82.20");
    expect(defaultWifiAddress("robot")).toBeUndefined();
  });

  it("accepts a dotted address and refuses anything a robot cannot use", () => {
    expect(parseWifiAddress(" 10.55.1.77 ")).toEqual([10, 55, 1, 77]);
    for (const bad of ["", "10.55.1", "10.55.1.256", "0.55.1.1", "10.55.1.x", "10.55.1.1.1"]) {
      expect(parseWifiAddress(bad)).toBeNull();
    }
  });

  it("reads the robot's latest netstore.values and ignores everything else", () => {
    const rx = (line: string) => ({ direction: "rx" as const, line });
    expect(deriveRobotWifiAddress([rx("status ready=1")])).toBeUndefined();
    expect(
      deriveRobotWifiAddress([
        rx('{"ev":"netstore.values","ip":"10.55.29.48","stored":0,"default":"10.55.29.48"}'),
        rx('{"ev":"netstore.fail","why":"each part must be a whole number from 0 to 255"}'),
        rx('{"ev":"netstore.values","ip":"10.55.1.77","stored":1,"default":"10.55.29.48"}'),
      ]),
    ).toEqual({ ip: "10.55.1.77", stored: true });
  });
});
