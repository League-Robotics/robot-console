import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseArgs } from "./index.js";

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
