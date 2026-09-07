import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceIdToName, nameToValue, NAME_SPACE } from "./naming.js";
import { base5, nameToRadioAddress, radioAddressToName } from "./radioAddress.js";

// ---------------------------------------------------------------------
// Conformance fixture: read from the vendored submodule, never copied
// into this repo (stakeholder decision, ticket 002 — supersedes
// sprint.md's Open Question 1: a copy would silently drift from
// upstream, while the submodule pins an exact commit and updates
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
  const vectors = readVectorsFile();

  it("the vectors file itself declares the expected 3125-name space", () => {
    expect(vectors.properties.total_names).toBe(NAME_SPACE);
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

  it("v1 (full_space_sha256) matches -- diagnostic bisector", () => {
    const { v1 } = buildCanonicalForms();
    expect(sha256(v1)).toBe(vectors.properties.full_space_sha256);
  });

  it("v2 (conformance_sha256) matches the entire 3125-name space -- the conformance gate", () => {
    const { v2 } = buildCanonicalForms();
    expect(sha256(v2)).toBe(vectors.properties.conformance_sha256);
  });
});
