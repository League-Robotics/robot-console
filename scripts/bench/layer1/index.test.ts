import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseArgs, classifyUsbDevice } from "./index.js";
import type { TranscriptLine } from "./types.js";

describe("parseArgs", () => {
  it("defaults to no --skip-held and an out path under cwd", () => {
    const result = parseArgs([]);
    expect(result.skipHeld).toBe(false);
    expect(result.outPath).toBe(path.join(process.cwd(), "bench-layer1-report.json"));
  });

  it("recognizes --skip-held", () => {
    expect(parseArgs(["--skip-held"]).skipHeld).toBe(true);
  });

  it("recognizes --out with its path argument", () => {
    expect(parseArgs(["--out", "/tmp/report.json"]).outPath).toBe("/tmp/report.json");
  });

  it("recognizes both flags together, in either order", () => {
    expect(parseArgs(["--skip-held", "--out", "/tmp/a.json"])).toEqual({ skipHeld: true, outPath: "/tmp/a.json" });
    expect(parseArgs(["--out", "/tmp/b.json", "--skip-held"])).toEqual({ skipHeld: true, outPath: "/tmp/b.json" });
  });

  it("throws a clear error when --out is missing its argument", () => {
    expect(() => parseArgs(["--out"])).toThrow("--out requires a path argument");
  });
});

describe("classifyUsbDevice", () => {
  const line = (dir: TranscriptLine["dir"], text: string): TranscriptLine => ({ t: 0, dir, line: text });

  it("names and classifies a robot from its captured banner", () => {
    const result = classifyUsbDevice(
      { transcript: [line("tx", "HELLO"), line("rx", "device NEZHA2 robot gopiv 2175407711")] },
      "fallback-serial",
    );
    expect(result).toEqual({ deviceName: "gopiv", kind: "robot" });
  });

  it("names and classifies a relay from its captured banner", () => {
    const result = classifyUsbDevice(
      { transcript: [line("tx", "HELLO"), line("rx", "DEVICE:RADIOBRIDGE:relay:vitut:2198604104")] },
      "fallback-serial",
    );
    expect(result).toEqual({ deviceName: "vitut", kind: "relay" });
  });

  it("stays 'unknown' with the fallback name when no banner was ever captured -- even when the failure reason speculates about a relay (018-002 regression: no banner should never imply kind 'relay')", () => {
    // This is exactly usbProbe.ts's own break-reset retry failure shape:
    // the *reason* text says "relay may be parked in the data plane"
    // while speculating about *why* nothing arrived, but no "rx"
    // transcript line was ever recorded -- nothing was ever confirmed.
    const result = classifyUsbDevice(
      { transcript: [line("tx", "HELLO"), line("info", "no banner -- relay may be parked in the data plane; attempting one break-reset retry"), line("tx", "HELLO")] },
      "99063602000528202e78ea8f7143163f000000006e052820",
    );
    expect(result).toEqual({ deviceName: "99063602000528202e78ea8f7143163f000000006e052820", kind: "unknown" });
  });

  it("falls back to the relay:<name>: banner shape", () => {
    const result = classifyUsbDevice(
      { transcript: [line("rx", "DEVICE:RADIOBRIDGE:relay:gozop:4267970133")] },
      "fallback-serial",
    );
    expect(result).toEqual({ deviceName: "gozop", kind: "relay" });
  });
});
