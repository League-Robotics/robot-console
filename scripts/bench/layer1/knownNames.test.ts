import { describe, expect, it } from "vitest";
import { parseKnownRobotsFile } from "./knownNames.js";

const REAL_BENCH_FILE = JSON.stringify({
  version: 1,
  robots: [
    { name: "gopiv", firstSeenAt: "2026-09-08T21:58:03.023Z" },
    { name: "tigez", firstSeenAt: "2026-09-10T17:26:57.760Z" },
    { name: "tovez", firstSeenAt: "2026-09-10T23:06:33.421Z" },
    { name: "vevov", firstSeenAt: "2026-09-10T20:06:33.108Z" },
    { name: "vitut", firstSeenAt: "2026-09-11T05:14:41.648Z" },
  ],
});

describe("parseKnownRobotsFile", () => {
  it("extracts every robot's name, in file order (real bench fixture)", () => {
    expect(parseKnownRobotsFile(REAL_BENCH_FILE)).toEqual(["gopiv", "tigez", "tovez", "vevov", "vitut"]);
  });

  it("returns [] for invalid JSON, never throwing", () => {
    expect(parseKnownRobotsFile("not json")).toEqual([]);
  });

  it("returns [] when the top-level shape has no robots array", () => {
    expect(parseKnownRobotsFile(JSON.stringify({ version: 1 }))).toEqual([]);
  });

  it("skips malformed entries but keeps well-formed ones", () => {
    const raw = JSON.stringify({ robots: [{ name: "gopiv" }, { notName: "x" }, "garbage", { name: 5 }] });
    expect(parseKnownRobotsFile(raw)).toEqual(["gopiv"]);
  });
});
