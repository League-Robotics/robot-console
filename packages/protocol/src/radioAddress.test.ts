import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceIdToName, nameToValue, NAME_SPACE } from "./naming.js";
import {
  base5,
  nameToRadioAddress,
  radioAddressToName,
  validateHardwareRadioAddress,
  validateRadioAddress,
} from "./radioAddress.js";

// ---------------------------------------------------------------------
// Conformance fixture: read from the vendored submodule, never copied
// into this repo (stakeholder decision — a copy would silently drift
// from upstream, while the submodule pins an exact commit and updates
// deliberately).
//
// Canonical upstream source:
//   vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json
//   (normative spec: vendor/pxt-nezha-diffdrive/docs/radio-addressing.md)
// ---------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");
const VECTORS_PATH = path.join(
  REPO_ROOT,
  "vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json",
);

/**
 * Whether the `vendor/pxt-nezha-diffdrive` submodule is initialized in
 * this checkout. The full-space conformance tests below are gated on
 * this (ticket 014-004's fixture-independence acceptance criterion) so
 * the synthetic, fixture-free tests in this file (the endianness trap,
 * the round-trip) always run without `git submodule update --init`.
 */
const VENDOR_PRESENT = existsSync(VECTORS_PATH);

interface VectorsFile {
  properties: {
    total_names: number;
    full_space_sha256: string;
    conformance_sha256: string;
  };
}

function readVectorsFile(): VectorsFile {
  let raw: string;
  try {
    raw = readFileSync(VECTORS_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Conformance vectors file not found at ${VECTORS_PATH}. ` +
          "The vendor/pxt-nezha-diffdrive submodule is not initialized -- " +
          "run `git submodule update --init` from the repo root, then re-run the tests.",
      );
    }
    throw err;
  }
  return JSON.parse(raw) as VectorsFile;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("radioAddress endianness trap", () => {
  // specification.md §3.2 / the vectors file's "endianness" note:
  // n=1 encodes to "zuzuv". A little-endian (reversed-digit) encoder
  // would instead produce "vuzuz" for the same input, and "vuzuz" is
  // itself a well-formed, distinct, regex-passing name -- so this bug
  // is invisible to any check that doesn't compare against the
  // published, order-sensitive vectors. This is the fastest localizer
  // to run first if the full-space conformance test below ever fails.
  it("zuzuv is n=1, not vuzuz", () => {
    expect(nameToValue("zuzuv")).toBe(1);
    expect(base5("zuzuv")).toBe(1);
    expect(deviceIdToName(1)).toBe("zuzuv");
    expect(nameToValue("vuzuz")).not.toBe(1);
  });
});

describe("round-trip via radioAddress.ts's base5", () => {
  // id -> name (naming.ts's deviceIdToName) -> n (radioAddress.ts's
  // own base5 export) -> same id. Exercises the full name space so a
  // reversed decoder --  which would still agree with a reversed
  // encoder on any single sampled id -- cannot hide.
  it("round-trips every id in [0, 3124] through radioAddress.ts's base5", () => {
    for (let id = 0; id < NAME_SPACE; id++) {
      const name = deviceIdToName(id);
      expect(base5(name)).toBe(id);
    }
  });
});

describe("nameToRadioAddress / radioAddressToName full-space conformance", () => {
  const vectors = VENDOR_PRESENT ? readVectorsFile() : undefined;

  it.skipIf(!VENDOR_PRESENT)("the vectors file itself declares the expected 3125-name space", () => {
    expect(vectors!.properties.total_names).toBe(NAME_SPACE);
  });

  // The vectors file publishes two digests for two canonical forms
  // (see its own `properties.dump_protocol`):
  //
  //   v1 / full_space_sha256   -- 3 columns, "<name>,<channel>,<group>".
  //     Forces encode(n->name) and address(n->pair) only; a decode()
  //     or reverse() bug can be byte-identical here (see the file's
  //     own `full_space_sha256_note`). Kept below as a diagnostic
  //     bisector, not the gate.
  //
  //   v2 / conformance_sha256  -- 5 columns, adding decode(name) and
  //     reverse(channel,group) as trailing columns (both always equal
  //     n). The file's own `conformance_sha256_note` names this THE
  //     PRIMARY conformance constant, because decode() is the
  //     production path (what `!N <name>` executes on every relay
  //     command) and v1 alone would pass a build with a broken
  //     decode()/reverse() unnoticed.
  //
  // This test asserts against v2 (conformance_sha256) as the gate,
  // per the file's own designation, and against v1
  // (full_space_sha256) as a bisector: if only v2 fails, the fault is
  // localized to nameToValue/base5 (decode) or radioAddressToName
  // (reverse); if both fail, the fault is in deviceIdToName (encode)
  // or nameToRadioAddress (address).

  function buildCanonicalForms(): { v1: string; v2: string } {
    const v1Lines: string[] = [];
    const v2Lines: string[] = [];
    for (let n = 0; n < NAME_SPACE; n++) {
      const name = deviceIdToName(n);
      const { channel, group } = nameToRadioAddress(name);
      v1Lines.push(`${name},${channel},${group}\n`);
      const decoded = nameToValue(name);
      const reversed = nameToValue(radioAddressToName(channel, group));
      v2Lines.push(`${name},${channel},${group},${decoded},${reversed}\n`);
    }
    return { v1: v1Lines.join(""), v2: v2Lines.join("") };
  }

  it.skipIf(!VENDOR_PRESENT)("v1 (full_space_sha256) matches -- diagnostic bisector", () => {
    const { v1 } = buildCanonicalForms();
    expect(sha256(v1)).toBe(vectors!.properties.full_space_sha256);
  });

  it.skipIf(!VENDOR_PRESENT)("v2 (conformance_sha256) matches the entire 3125-name space -- the conformance gate", () => {
    const { v2 } = buildCanonicalForms();
    expect(sha256(v2)).toBe(vectors!.properties.conformance_sha256);
  });
});

describe("validateRadioAddress", () => {
  // radio-robot-lib docs/design/radio-addressing.md (adopted 2026-09-13):
  // channel = 11 + (n % 73), group = 15 + (n % 241).
  it("accepts every pair a name derives", () => {
    expect(validateRadioAddress(11, 15)).toBe(true); // zuzuz, n = 0
    expect(validateRadioAddress(69, 247)).toBe(true); // tatat, n = 3124
    expect(validateRadioAddress(48, 29)).toBe(true); // tovez
    expect(validateRadioAddress(12, 30)).toBe(true); // gopiv
  });

  it("rejects a pair inside the ranges that belongs to no name", () => {
    expect(validateRadioAddress(11, 16)).toBe(false);
  });

  it("rejects a channel outside [11, 83]", () => {
    expect(validateRadioAddress(10, 15)).toBe(false);
    expect(validateRadioAddress(84, 15)).toBe(false);
  });

  it("rejects a group outside [15, 255]", () => {
    expect(validateRadioAddress(11, 14)).toBe(false);
    expect(validateRadioAddress(11, 256)).toBe(false);
  });

  it("never throws, unlike radioAddressToName", () => {
    expect(() => validateRadioAddress(11, 16)).not.toThrow();
    expect(() => radioAddressToName(11, 16)).toThrow();
  });

  it("rejects a non-integer channel/group", () => {
    expect(validateRadioAddress(11.5, 15)).toBe(false);
    expect(validateRadioAddress(11, NaN)).toBe(false);
  });
});

describe("validateHardwareRadioAddress", () => {
  it("accepts any pair the radio can be tuned to, derived or not", () => {
    expect(validateHardwareRadioAddress(0, 0)).toBe(true);
    expect(validateHardwareRadioAddress(83, 255)).toBe(true);
    expect(validateHardwareRadioAddress(55, 108)).toBe(true); // a pinned pair
    expect(validateHardwareRadioAddress(11, 16)).toBe(true); // no name derives it
  });

  it("rejects values outside the radio's limits or non-integers", () => {
    expect(validateHardwareRadioAddress(84, 0)).toBe(false);
    expect(validateHardwareRadioAddress(0, 256)).toBe(false);
    expect(validateHardwareRadioAddress(-1, 0)).toBe(false);
    expect(validateHardwareRadioAddress(1.5, 0)).toBe(false);
  });
});
