import { describe, expect, it } from "vitest";
import { parseArgs, targetForPath, resourceForEndpoint, resourceKey } from "./index.js";
import type { PathResult } from "../layer1/types.js";

describe("parseArgs", () => {
  it("recognizes --state-dir, --out, --layer1, --port, --skip-held together", () => {
    const result = parseArgs(["--state-dir", "/tmp/state", "--out", "/tmp/out.json", "--layer1", "/tmp/l1.json", "--port", "4800", "--skip-held"]);
    expect(result).toEqual({ stateDir: "/tmp/state", outPath: "/tmp/out.json", layer1Path: "/tmp/l1.json", port: 4800, skipHeld: true });
  });

  it("defaults skipHeld to false and port to 4799 when not given", () => {
    const result = parseArgs(["--state-dir", "/tmp/state"]);
    expect(result.skipHeld).toBe(false);
    expect(result.port).toBe(4799);
  });

  it("generates a fresh temp state dir when --state-dir is not given", () => {
    const a = parseArgs([]);
    const b = parseArgs([]);
    expect(a.stateDir).not.toBe(b.stateDir);
    expect(a.stateDir).toContain("bench-layer2-state-");
  });
});

function pathResult(over: Partial<PathResult> = {}): PathResult {
  return { path: "mbserial", endpoint: { host: "loki.local", port: 1234 }, status: "pass", reason: "ok", transcript: [], ...over };
}

describe("targetForPath", () => {
  it("maps a usb path to a direct usb target", () => {
    expect(targetForPath("vitut", "relay", pathResult({ path: "usb" }))).toEqual({ kind: "direct", deviceName: "vitut", transport: "usb" });
  });

  it("maps an mbserial path to a direct mbserial target", () => {
    expect(targetForPath("gopiv", "robot", pathResult({ path: "mbserial" }))).toEqual({ kind: "direct", deviceName: "gopiv", transport: "mbserial" });
  });

  it("maps a wifi path to a direct wifi target", () => {
    expect(targetForPath("gopiv", "robot", pathResult({ path: "wifi" }))).toEqual({ kind: "direct", deviceName: "gopiv", transport: "wifi" });
  });

  it("maps a radio-via-mbrelay:<pool> path to a radio target for a robot", () => {
    expect(targetForPath("gopiv", "robot", pathResult({ path: "radio-via-mbrelay:torture" }))).toEqual({
      kind: "radio",
      deviceName: "gopiv",
      relayName: "torture",
    });
  });

  it("skips the pool's own radio-via-mbrelay row (kind: pool) -- it is not a robot reached through a relay", () => {
    expect(targetForPath("torture", "pool", pathResult({ path: "radio-via-mbrelay:torture" }))).toBeUndefined();
  });

  it("skips mbserial-contention -- Layer 1's own demonstration path, not a Layer 2 target", () => {
    expect(targetForPath("gopiv", "robot", pathResult({ path: "mbserial-contention" }))).toBeUndefined();
  });
});

describe("resourceForEndpoint / resourceKey", () => {
  it("builds a serial resource from a serialPath endpoint", () => {
    const resource = resourceForEndpoint({ serialPath: "/dev/cu.usbmodem1" });
    expect(resource).toEqual({ kind: "serial", path: "/dev/cu.usbmodem1" });
    expect(resourceKey(resource)).toBe("/dev/cu.usbmodem1");
  });

  it("builds a tcp resource preferring the resolved ip over the hostname", () => {
    const resource = resourceForEndpoint({ host: "loki.local", ip: "192.168.1.1", port: 4321 });
    expect(resource).toEqual({ kind: "tcp", host: "192.168.1.1", port: 4321 });
    expect(resourceKey(resource)).toBe("192.168.1.1:4321");
  });

  it("falls back to the hostname when no ip was resolved", () => {
    const resource = resourceForEndpoint({ host: "loki.local", port: 4321 });
    expect(resource).toEqual({ kind: "tcp", host: "loki.local", port: 4321 });
  });
});
