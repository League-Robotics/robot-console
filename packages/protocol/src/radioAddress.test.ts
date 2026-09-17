import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceIdToName, nameToValue, NAME_CODEBOOK, NAME_SPACE } from "./naming.js";
import {
  base5,
  isHardwareRadioPair,
  nameToRadioAddress,
  normalizeRadioName,
  radioAddressCanonicalForm,
  radioAddressToName,
  validateRadioAddress,
} from "./radioAddress.js";

// ---------------------------------------------------------------------
// Conformance fixture: `radio-address-vectors.json`, next to this file.
//
// Copied from microbit-radio-relay `server/tests/radio-address-vectors.json`,
// which is transcribed from the normative spec, radio-robot-lib
// `docs/design/radio-addressing.md`. If the spec changes, re-copy it;
// the spec wins over this file. The vendored
// `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json` describes
// the retired 25-channel map and is not used.
// ---------------------------------------------------------------------

const VECTORS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "radio-address-vectors.json");

interface Vector {
  name: string;
  n: number;
  channel: number;
  group: number;
}

interface VectorsFile {
  properties: {
    total_names: number;
    distinct_pairs: number;
    full_space_sha256: string;
    conformance_sha256: string;
    conformance_sha256_broken_decode: { digest: string };
    endianness_probe: { vector: string; reversed_encoder_digest: string };
  };
  reject: string[];
  normalize_equivalent: Record<string, string>;
  no_name_pairs: Array<[number, number]>;
  vectors: Vector[];
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorsFile;

/** Spec digests, restated so a silently edited fixture can't move the gate. */
const D1 = "c22691f1c47bed3ac5317119487a30ea8fd0224d61c50bba551b1e624b548a84";
const D2 = "305d6ee08cfae978fe13e1179c6047a56e1b0b1abe23c2cb757f01461cf2d35f";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("radioAddress endianness trap", () => {
  // n=1 encodes to "zuzuv". A little-endian (reversed-digit) encoder
  // would instead produce "vuzuz", itself a well-formed, distinct name,
  // so the bug is invisible to a sampled check.
  it("zuzuv is n=1, not vuzuz", () => {
    expect(nameToValue("zuzuv")).toBe(1);
    expect(base5("zuzuv")).toBe(1);
    expect(deviceIdToName(1)).toBe("zuzuv");
    expect(nameToValue("vuzuz")).not.toBe(1);
    expect(nameToRadioAddress("zuzuv")).toEqual({ channel: 12, group: 16 });
  });

  it("a little-endian encoder yields the spec's reversed-encoder D1, and ours does not", () => {
    // Build D1 with an encoder that puts the least significant digit at
    // position 0. The spec publishes this digest as the symptom; hitting
    // it proves the harness below would name that bug.
    const reversedEncoder = (n: number): string => {
      let rest = n;
      let out = "";
      for (let p = 0; p < 5; p++) {
        out += NAME_CODEBOOK[p]![rest % 5]!;
        rest = Math.floor(rest / 5);
      }
      return out;
    };
    let text = "";
    for (let n = 0; n < NAME_SPACE; n++) {
      const { channel, group } = { channel: 11 + (n % 73), group: 15 + (n % 241) };
      text += `${reversedEncoder(n)},${channel},${group}\n`;
    }
    expect(sha256(text)).toBe(vectors.properties.endianness_probe.reversed_encoder_digest);
    expect(radioAddressCanonicalForm(1)).not.toBe(text);
  });

  it("a little-endian decoder yields the spec's broken-decode D2, and ours does not", () => {
    // Correct encoder and map; only the decode(name) column reads the
    // letters least-significant first.
    const reversedDecoder = (name: string): number => {
      let n = 0;
      for (let p = 4; p >= 0; p--) {
        n = n * 5 + NAME_CODEBOOK[p]!.indexOf(name[p]!);
      }
      return n;
    };
    let text = "";
    for (let n = 0; n < NAME_SPACE; n++) {
      const name = deviceIdToName(n);
      const { channel, group } = nameToRadioAddress(name);
      text += `${name},${channel},${group},${reversedDecoder(name)},${nameToValue(radioAddressToName(channel, group))}\n`;
    }
    expect(sha256(text)).toBe(vectors.properties.conformance_sha256_broken_decode.digest);
  });

  it("the spec's hand-test names: zuzuv and zotuz", () => {
    expect(nameToValue("zotuz")).toBe(225);
    expect(nameToRadioAddress("zotuz")).toEqual({ channel: 17, group: 240 });
  });
});

describe("round-trip via radioAddress.ts's base5", () => {
  it("round-trips every id in [0, 3124] through radioAddress.ts's base5", () => {
    for (let id = 0; id < NAME_SPACE; id++) {
      expect(base5(deviceIdToName(id))).toBe(id);
    }
  });
});

describe("nameToRadioAddress / radioAddressToName full-space conformance (D1, D2)", () => {
  it("the vectors file declares the 3125-name space and the spec's digests", () => {
    expect(vectors.properties.total_names).toBe(NAME_SPACE);
    expect(vectors.properties.full_space_sha256).toBe(D1);
    expect(vectors.properties.conformance_sha256).toBe(D2);
  });

  // Built inline, independently of radioAddressCanonicalForm, so the
  // exported helper (what tools/radio-address-dump prints) is checked too.
  function buildCanonicalForms(): { v1: string; v2: string } {
    const v1: string[] = [];
    const v2: string[] = [];
    for (let n = 0; n < NAME_SPACE; n++) {
      const name = deviceIdToName(n);
      const { channel, group } = nameToRadioAddress(name);
      v1.push(`${name},${channel},${group}\n`);
      const decoded = nameToValue(name);
      const reversed = nameToValue(radioAddressToName(channel, group));
      v2.push(`${name},${channel},${group},${decoded},${reversed}\n`);
    }
    return { v1: v1.join(""), v2: v2.join("") };
  }

  it("D1 (forward only) matches -- diagnostic bisector", () => {
    const { v1 } = buildCanonicalForms();
    expect(sha256(v1)).toBe(D1);
  });

  it("D2 matches over the entire 3125-name space -- the conformance gate", () => {
    const { v2 } = buildCanonicalForms();
    const digest = sha256(v2);
    expect(digest, "D2 equals the spec's broken-decode digest: the decoder is little-endian").not.toBe(
      vectors.properties.conformance_sha256_broken_decode.digest,
    );
    expect(digest).toBe(D2);
  });

  it("radioAddressCanonicalForm (the dump tool's output) matches D1 and D2", () => {
    expect(sha256(radioAddressCanonicalForm(1))).toBe(D1);
    expect(sha256(radioAddressCanonicalForm(2))).toBe(D2);
    expect(sha256(radioAddressCanonicalForm())).toBe(D2);
  });

  it("3125 names map to 3125 distinct pairs, all inside 11-83 / 15-255", () => {
    const seen = new Set<string>();
    for (let n = 0; n < NAME_SPACE; n++) {
      const { channel, group } = nameToRadioAddress(deviceIdToName(n));
      expect(channel).toBeGreaterThanOrEqual(11);
      expect(channel).toBeLessThanOrEqual(83);
      expect(group).toBeGreaterThanOrEqual(15);
      expect(group).toBeLessThanOrEqual(255);
      seen.add(`${channel}/${group}`);
    }
    expect(seen.size).toBe(vectors.properties.distinct_pairs);
  });
});

describe("spec vectors", () => {
  for (const vector of vectors.vectors) {
    it(`${vector.name} is n=${vector.n}, ${vector.channel}/${vector.group}, and reverses to itself`, () => {
      expect(nameToValue(vector.name)).toBe(vector.n);
      expect(nameToRadioAddress(vector.name)).toEqual({ channel: vector.channel, group: vector.group });
      expect(radioAddressToName(vector.channel, vector.group)).toBe(vector.name);
      expect(validateRadioAddress(vector.channel, vector.group)).toBe(true);
    });
  }

  it("tigez (fleet plan, not in the spec table) is 52/179", () => {
    expect(nameToRadioAddress("tigez")).toEqual({ channel: 52, group: 179 });
    expect(radioAddressToName(52, 179)).toBe("tigez");
  });

  it("covers the spec's edge names", () => {
    const edges = Object.fromEntries(vectors.vectors.map((v) => [v.name, [v.channel, v.group]]));
    expect(edges).toMatchObject({
      zuzuz: [11, 15],
      zuzuv: [12, 16],
      zugag: [83, 87],
      zugap: [11, 88],
      zotuz: [17, 240],
      zotez: [32, 255],
      zotev: [33, 15],
      tatat: [69, 247],
      tovez: [48, 29],
      vevov: [20, 82],
      gopiv: [12, 30],
    });
  });

  for (const bad of vectors.reject) {
    it(`rejects the name ${JSON.stringify(bad)}`, () => {
      expect(() => nameToRadioAddress(bad)).toThrow();
    });
  }

  for (const [input, canonical] of Object.entries(vectors.normalize_equivalent)) {
    it(`accepts ${JSON.stringify(input)} as ${canonical}`, () => {
      expect(normalizeRadioName(input)).toBe(canonical);
      expect(nameToRadioAddress(input)).toEqual(nameToRadioAddress(canonical));
    });
  }

  for (const [channel, group] of vectors.no_name_pairs) {
    it(`reverse rejects ${channel}/${group}, a pair no name derives`, () => {
      expect(() => radioAddressToName(channel, group)).toThrow(/belongs to no name/);
      expect(validateRadioAddress(channel, group)).toBe(false);
    });
  }
});

describe("radioAddressToName range rejection", () => {
  it("rejects channels outside 11-83 and groups outside 15-255", () => {
    expect(() => radioAddressToName(10, 15)).toThrow(/channel 10/);
    expect(() => radioAddressToName(84, 15)).toThrow(/channel 84/);
    expect(() => radioAddressToName(11, 14)).toThrow(/group 14/);
    expect(() => radioAddressToName(11, 256)).toThrow(/group 256/);
  });

  it("no longer rejects even channels or group 10 as such -- those rules belonged to the old map", () => {
    // 48/29 is tovez: an even channel is fine now.
    expect(radioAddressToName(48, 29)).toBe("tovez");
  });
});

describe("validateRadioAddress", () => {
  it("accepts exactly the 3125 derived pairs out of every in-range pair", () => {
    let count = 0;
    for (let channel = 11; channel <= 83; channel++) {
      for (let group = 15; group <= 255; group++) {
        if (validateRadioAddress(channel, group)) {
          count++;
          expect(nameToRadioAddress(radioAddressToName(channel, group))).toEqual({ channel, group });
        }
      }
    }
    expect(count).toBe(NAME_SPACE);
  });

  it("rejects pairs outside 11-83 / 15-255", () => {
    expect(validateRadioAddress(10, 15)).toBe(false);
    expect(validateRadioAddress(84, 15)).toBe(false);
    expect(validateRadioAddress(11, 14)).toBe(false);
    expect(validateRadioAddress(11, 256)).toBe(false);
    expect(validateRadioAddress(0, 10)).toBe(false);
  });

  it("never throws, unlike radioAddressToName", () => {
    expect(() => validateRadioAddress(10, 10)).not.toThrow();
    expect(() => radioAddressToName(10, 10)).toThrow();
  });

  it("rejects a non-integer channel/group", () => {
    expect(validateRadioAddress(11.5, 15)).toBe(false);
    expect(validateRadioAddress(11, NaN)).toBe(false);
  });
});

describe("isHardwareRadioPair", () => {
  it("accepts any integer pair in channel 0-83 / group 0-255, derived or not", () => {
    expect(isHardwareRadioPair(0, 0)).toBe(true);
    expect(isHardwareRadioPair(83, 255)).toBe(true);
    expect(isHardwareRadioPair(37, 43)).toBe(true); // old-map pair
    expect(isHardwareRadioPair(48, 29)).toBe(true); // new-map pair
    expect(isHardwareRadioPair(11, 16)).toBe(true); // no name derives it
  });

  it("rejects out-of-range or non-integer values", () => {
    expect(isHardwareRadioPair(84, 0)).toBe(false);
    expect(isHardwareRadioPair(-1, 0)).toBe(false);
    expect(isHardwareRadioPair(0, 256)).toBe(false);
    expect(isHardwareRadioPair(0, -1)).toBe(false);
    expect(isHardwareRadioPair(1.5, 0)).toBe(false);
    expect(isHardwareRadioPair(0, NaN)).toBe(false);
  });
});
