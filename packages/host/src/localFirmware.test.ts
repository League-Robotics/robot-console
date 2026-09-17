/**
 * localFirmware.test.ts — out-of-process, 2026-09-16. Exercises the
 * filesystem counterpart to `releases.test.ts`: every case runs against
 * real files in a fresh temp directory (there is no network seam to
 * inject here, and stat/read against a tmpdir is fast and honest), and
 * every failure mode is asserted as a returned value, never a throw.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatBuildStamp, readLocalHex, resolveLocalHex } from "./localFirmware.js";

/** A minimal but genuinely well-formed Intel hex: one data record and
 * the `:00000001FF` end-of-file record `flash.ts`'s
 * `isValidIntelHexText` requires. */
const VALID_HEX = [":100000000102030405060708090A0B0C0D0E0F1068", ":00000001FF", ""].join("\n");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "robot-console-local-firmware-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveLocalHex", () => {
  it("reports file-missing for a path with nothing at it", async () => {
    const result = await resolveLocalHex({ kind: "local-file", hexPath: path.join(dir, "nope.hex") });
    expect(result).toEqual({ reason: "file-missing", message: expect.stringContaining("nope.hex") });
  });

  it("reports not-a-file when the path is a directory", async () => {
    const asDir = path.join(dir, "built");
    await mkdir(asDir);
    const result = await resolveLocalHex({ kind: "local-file", hexPath: asDir });
    expect("reason" in result && result.reason).toBe("not-a-file");
  });

  it("resolves a real hex to its name, size, and mtime-derived build stamp", async () => {
    const hexPath = path.join(dir, "MICROBIT.hex");
    await writeFile(hexPath, VALID_HEX);

    const result = await resolveLocalHex({ kind: "local-file", hexPath });
    expect("reason" in result).toBe(false);
    const resolved = result as Exclude<typeof result, { reason: string }>;
    expect(resolved.fileName).toBe("MICROBIT.hex");
    expect(resolved.hexPath).toBe(hexPath);
    expect(resolved.byteLength).toBe(Buffer.byteLength(VALID_HEX));
    expect(resolved.builtAt).toBeGreaterThan(0);
    expect(resolved.tag).toBe(formatBuildStamp(resolved.builtAt));
  });

  it("never throws for any of its failure modes", async () => {
    await expect(resolveLocalHex({ kind: "local-file", hexPath: path.join(dir, "a.hex") })).resolves.toBeDefined();
    await expect(resolveLocalHex({ kind: "local-file", hexPath: dir })).resolves.toBeDefined();
  });
});

describe("readLocalHex", () => {
  it("returns the bytes of a well-formed hex", async () => {
    const hexPath = path.join(dir, "MICROBIT.hex");
    await writeFile(hexPath, VALID_HEX);

    const result = await readLocalHex({ kind: "local-file", hexPath });
    expect("reason" in result).toBe(false);
    expect((result as { hex: Buffer }).hex.toString("utf-8")).toBe(VALID_HEX);
  });

  it("rejects a file that is not well-formed Intel hex, and returns no bytes", async () => {
    const hexPath = path.join(dir, "MICROBIT.hex");
    await writeFile(hexPath, "this is not a hex file\n");

    const result = await readLocalHex({ kind: "local-file", hexPath });
    expect("reason" in result && result.reason).toBe("invalid-hex");
    expect("hex" in result).toBe(false);
  });

  it("rejects a truncated hex with no end-of-file record -- the half-written-build case", async () => {
    const hexPath = path.join(dir, "MICROBIT.hex");
    await writeFile(hexPath, ":100000000102030405060708090A0B0C0D0E0F1068\n");

    const result = await readLocalHex({ kind: "local-file", hexPath });
    expect("reason" in result && result.reason).toBe("invalid-hex");
  });

  it("propagates a missing file rather than throwing", async () => {
    const result = await readLocalHex({ kind: "local-file", hexPath: path.join(dir, "gone.hex") });
    expect("reason" in result && result.reason).toBe("file-missing");
  });
});

describe("formatBuildStamp", () => {
  it("renders a readable local-time build stamp at minute resolution", () => {
    // Constructed in local time so the assertion holds in any timezone.
    const at = new Date(2026, 8, 13, 10, 52, 30).getTime();
    expect(formatBuildStamp(at)).toBe("built 2026-09-13 10:52");
  });

  it("zero-pads single-digit months, days, hours, and minutes", () => {
    const at = new Date(2026, 0, 2, 3, 4, 0).getTime();
    expect(formatBuildStamp(at)).toBe("built 2026-01-02 03:04");
  });
});
