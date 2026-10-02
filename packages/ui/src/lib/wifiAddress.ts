/**
 * wifiAddress.ts — a robot's fixed Wi-Fi address: the default its name
 * derives, what the robot itself reports (`RUN netshow`), and the checks
 * on a typed one.
 */
import { nameToWifiAddress } from "@robot-console/protocol";
import { parseCalibrationLine } from "../components/CalibrationReport";

/** `10.55.<group>.<channel>` for a robot name, or `undefined` for anything else. */
export function defaultWifiAddress(name: string): string | undefined {
  try {
    return nameToWifiAddress(name);
  } catch {
    return undefined;
  }
}

/** The four parts of a dotted address, or `null` when it is not one a robot can use. */
export function parseWifiAddress(text: string): [number, number, number, number] | null {
  const parts = text.trim().split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255) || numbers[0] === 0) {
    return null;
  }
  return numbers as [number, number, number, number];
}

export interface RobotWifiAddress {
  ip: string;
  /** True when the robot holds a stored address; false when it uses its name's default. */
  stored: boolean;
}

/** The latest `netstore.values` a robot sent on this link, if any. */
export function deriveRobotWifiAddress(
  entries: readonly { direction: "tx" | "rx"; line: string }[],
): RobotWifiAddress | undefined {
  let latest: RobotWifiAddress | undefined;
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const parsed = parseCalibrationLine(entry.line);
    if (parsed?.verb === "netstore" && parsed.kind === "other" && parsed.suffix === "values") {
      const ip = parsed.fields.ip;
      if (typeof ip === "string" && parseWifiAddress(ip) !== null) {
        latest = { ip, stored: parsed.fields.stored === 1 };
      }
    }
  }
  return latest;
}
