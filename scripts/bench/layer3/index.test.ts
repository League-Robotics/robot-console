import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseArgs, targetsFromLayer2 } from "./index.js";
import type { Layer2Report } from "../layer2/types.js";

function layer2Fixture(devices: Layer2Report["devices"]): Layer2Report {
  return {
    startedAt: "2026-09-13T00:00:00.000Z",
    finishedAt: "2026-09-13T00:01:00.000Z",
    host: { os: "darwin 25.6.0", node: "v22.13.0" },
    hostUnderTest: { command: "node bin/robot-console.js --port 4799 --no-open", port: 4799, stateDir: "/tmp/x" },
    settle: { settled: true, elapsedMs: 5000, neverAppeared: [] },
    devices,
    assertions: [],
  };
}

describe("parseArgs", () => {
  it("defaults every path/port sensibly", () => {
    const result = parseArgs([]);
    expect(result.layer2Path).toBe(path.join(process.cwd(), "bench-layer2-report.json"));
    expect(result.outPath).toBe(path.join(process.cwd(), "bench-layer3-report.json"));
    expect(result.port).toBe(4798);
  });

  it("recognizes every flag", () => {
    const result = parseArgs(["--layer2", "/tmp/l2.json", "--out", "/tmp/l3.json", "--port", "5001", "--state-dir", "/tmp/state", "--screenshot-dir", "/tmp/shots"]);
    expect(result).toEqual({
      layer2Path: "/tmp/l2.json",
      outPath: "/tmp/l3.json",
      port: 5001,
      stateDir: "/tmp/state",
      screenshotDir: "/tmp/shots",
    });
  });
});

describe("targetsFromLayer2", () => {
  it("includes every non-skipped path, whether it passed or failed Layer 2", () => {
    const layer2 = layer2Fixture([
      {
        name: "gopiv",
        kind: "robot",
        paths: [
          { path: "mbserial", layer1: { status: "pass", reason: "ok" }, layer2: { status: "pass", reason: "ok", timings: {}, replies: {}, notices: [] } },
          { path: "radio-via-mbrelay:torture", layer1: { status: "pass", reason: "ok" }, layer2: { status: "fail", reason: "no reply", timings: {}, replies: {}, notices: [] } },
        ],
      },
      {
        name: "tigez",
        kind: "robot",
        paths: [{ path: "mbserial", layer1: { status: "pass", reason: "ok" }, layer2: { status: "skipped", reason: "held", timings: {}, replies: {}, notices: [] } }],
      },
    ]);
    const targets = targetsFromLayer2(layer2);
    expect(targets).toEqual([
      { device: "gopiv", path: "mbserial" },
      { device: "gopiv", path: "radio-via-mbrelay:torture" },
    ]);
  });

  it("returns an empty list for an all-skipped report", () => {
    const layer2 = layer2Fixture([
      { name: "vitut", kind: "robot", paths: [{ path: "usb", layer1: { status: "pass", reason: "ok" }, layer2: { status: "skipped", reason: "held", timings: {}, replies: {}, notices: [] } }] },
    ]);
    expect(targetsFromLayer2(layer2)).toEqual([]);
  });
});
