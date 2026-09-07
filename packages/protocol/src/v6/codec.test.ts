import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CodecError,
  classifyLine,
  decodeLine,
  encodeLine,
  flagsField,
  isReplyVerb,
  MAX_LINE_BYTES,
  REPLY_VERBS,
  type DecodedLine,
} from "./codec.js";

// ---------------------------------------------------------------------
// Conformance fixture: read from the vendored submodule, never copied
// into this repo (same posture as radioAddress.test.ts, ticket 002 —
// a copy would silently drift from upstream, while the submodule pins
// an exact commit and updates deliberately). Parsed and filtered here
// at test time; the vectors themselves are never inlined.
//
// Canonical upstream source:
//   vendor/radio-robot-lib/tests/protocol/golden_vectors.txt
//   (normative spec: vendor/radio-robot-lib/docs/design/protocol.md)
// ---------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../",
);
const VECTORS_PATH = path.join(
  REPO_ROOT,
  "vendor/radio-robot-lib/tests/protocol/golden_vectors.txt",
);

function readVectorsFile(): string {
  try {
    return readFileSync(VECTORS_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Golden vectors file not found at ${VECTORS_PATH}. ` +
          "The vendor/radio-robot-lib submodule is not initialized -- " +
          "run `git submodule update --init` from the repo root, then re-run the tests.",
      );
    }
    throw err;
  }
}

interface WireVector {
  /** Which "# ---- ... ----" section header this vector fell under. */
  section: string;
  /** "IN" (host -> robot on the fixture's own terms) or "OUT" (a reply
   * the fixture expects). Both are just wire lines from codec.ts's own
   * point of view -- codec.ts is direction-agnostic about encode/decode,
   * it is `classifyLine` that cares about case. */
  direction: "IN" | "OUT";
  /** The literal wire content, with the "IN "/"OUT " fixture-format
   * prefix stripped and nothing else touched -- leading/trailing
   * whitespace and internal multi-space runs are preserved exactly as
   * the fixture wrote them, since some vectors exist specifically to
   * exercise that whitespace handling (see the "Grammar rules that are
   * easy to miss" section). */
  content: string;
}

/**
 * This ticket's scope is framing: HELLO/banner/ack/nack/id-extraction,
 * not the eleven sequenced verbs' own business semantics (WHEELS_X,
 * MOVE_X, GO_TO_R/W, STOP's accept/reject outcomes, TLM/telemetry --
 * sprint 3 and v6/telemetry.ts's own concerns). These are the fixture's
 * own section headers (see golden_vectors.txt's "# ---- ... ----"
 * banners) that stay on the framing side of that line:
 *
 *   - "Session verbs"            HELLO/PING/ID/VER/STATUS/HELP framing
 *   - "Grammar rules..."         whitespace-run + leading/trailing ws
 *   - "The reliability layer..." ack/nack shape, #0, id-absent-is-not-
 *                                 malformed
 *   - "Decode failure..."        nack/err framing, non-'#'-prefixed
 *                                 trailing tokens NOT read as an id
 *   - "debug: robot-to-host..."  the `debug` reply verb's own framing
 *   - "RUN: invocation by name"  `ret <value> #<id>` framing (RUN's own
 *                                 adapter-level accept/reject semantics
 *                                 are not what these vectors are used
 *                                 for below -- only the wire shape is)
 *
 * Explicitly excluded: "Motion", "STOP" (drive-verb semantics), "Error-
 * code coverage" (SET's own Result-to-code mapping), "Telemetry", "TLM
 * HDR" -- all sprint-3/telemetry-ticket territory.
 */
const INCLUDED_SECTIONS = [
  "Session verbs",
  "Grammar rules",
  "The reliability layer",
  "Decode failure",
  "debug: robot-to-host",
  "RUN: invocation by name",
];

function parseWireVectors(raw: string): WireVector[] {
  const vectors: WireVector[] = [];
  let section = "";
  // Section headers are "# ---- <title> ----" comment blocks, but the
  // title sometimes wraps onto a second "# ..." comment line before the
  // closing "----" (e.g. "The reliability layer..."), so the opening and
  // closing markers cannot be assumed to share one line.
  let inHeader = false;
  let headerText = "";
  for (const line of raw.split("\n")) {
    if (!inHeader && /^#\s*----/.test(line)) {
      inHeader = true;
      headerText = line.replace(/^#\s*----\s*/, "");
      if (headerText.includes("----")) {
        section = headerText.replace(/\s*----.*$/, "").trim();
        inHeader = false;
      }
      continue;
    }
    if (inHeader) {
      const stripped = line.replace(/^#\s*/, "");
      headerText += " " + stripped;
      if (stripped.includes("----")) {
        section = headerText.replace(/\s*----.*$/, "").trim();
        inHeader = false;
      }
      continue;
    }
    if (line.startsWith("IN ")) {
      vectors.push({ section, direction: "IN", content: line.slice(3) });
    } else if (line.startsWith("OUT ") && line !== "OUT NONE") {
      vectors.push({ section, direction: "OUT", content: line.slice(4) });
    }
  }
  return vectors;
}

const ALL_VECTORS = parseWireVectors(readVectorsFile());
const SCOPED_VECTORS = ALL_VECTORS.filter((v) =>
  INCLUDED_SECTIONS.some((s) => v.section.startsWith(s)),
);

// Sanity check on the filter itself: fail loudly (not "0 tests silently
// skipped") if the fixture's section headers ever get renamed upstream
// and the filter above stops matching anything.
describe("golden_vectors.txt fixture", () => {
  it("finds at least one vector in every scoped section", () => {
    expect(ALL_VECTORS.length).toBeGreaterThan(0);
    expect(SCOPED_VECTORS.length).toBeGreaterThan(0);
    for (const section of INCLUDED_SECTIONS) {
      const found = SCOPED_VECTORS.some((v) => v.section.startsWith(section));
      expect(found, `expected at least one vector under "${section}"`).toBe(
        true,
      );
    }
  });
});

// Vectors that deliberately carry non-canonical whitespace (extra
// interior spaces, leading spaces) to exercise the "run of spaces is
// ONE separator" / "leading and trailing whitespace is ignored" rules.
// These cannot round-trip byte-for-byte back through encodeLine (which
// always normalizes to single spaces and never emits leading
// whitespace) -- decoded structurally instead, below.
const NON_CANONICAL_WHITESPACE = new Set([
  "WHEELS_V   100   100   1000   #1",
  "   PING",
]);

describe("decodeLine/encodeLine round-trip every scoped golden vector", () => {
  const canonical = SCOPED_VECTORS.filter(
    (v) => !NON_CANONICAL_WHITESPACE.has(v.content),
  );
  it.each(canonical.map((v) => [v.section, v.direction, v.content] as const))(
    "[%s] %s %s",
    (_section, _direction, content) => {
      const decoded = decodeLine(content);
      expect(decoded.kind).toBe("line");
      const line = decoded as DecodedLine;
      // Re-encoding the exact fields/id decodeLine handed back must
      // reproduce the original wire text byte-for-byte -- the strongest
      // available check that encode and decode agree with each other
      // AND with real, upstream-sourced wire text, without this test
      // having to hand-author an expected {verb, fields, id} object for
      // every one of these lines.
      const reencoded = encodeLine(line.verb, line.fields, line.id);
      expect(reencoded).toBe(content + "\n");
    },
  );
});

describe("golden vectors: the ack/nack parsing trap (codec.py lines 48-55)", () => {
  it("ack's leading number is a bare fields[0], never .id", () => {
    const decoded = decodeLine("ack 1 0 none");
    expect(decoded).toEqual({
      kind: "line",
      verb: "ack",
      fields: ["1", "0", "none"],
    });
    expect((decoded as DecodedLine).id).toBeUndefined();
  });

  it("nack's leading number is a bare fields[0], never .id", () => {
    const decoded = decodeLine("nack 1 0 none");
    expect(decoded).toEqual({
      kind: "line",
      verb: "nack",
      fields: ["1", "0", "none"],
    });
    expect((decoded as DecodedLine).id).toBeUndefined();
  });

  it("ack 0 0 none -- a stale retransmit ack against id 0 is still no .id", () => {
    // golden_vectors.txt: SET .../ #0 (a stale retransmit) -> "ack 0 0 none".
    const decoded = decodeLine("ack 0 0 none");
    expect((decoded as DecodedLine).id).toBeUndefined();
    expect((decoded as DecodedLine).fields).toEqual(["0", "0", "none"]);
  });

  it("contrasts with err/ret, whose id IS a real trailing #<id>", () => {
    const err = decodeLine("err 3 #1") as DecodedLine;
    expect(err.verb).toBe("err");
    expect(err.fields).toEqual(["3"]);
    expect(err.id).toBe(1);

    const ret = decodeLine("ret 42 #1") as DecodedLine;
    expect(ret.verb).toBe("ret");
    expect(ret.fields).toEqual(["42"]);
    expect(ret.id).toBe(1);
  });
});

describe("golden vectors: whitespace framing rules (structural, not round-trip)", () => {
  it("a run of spaces is ONE separator (WHEELS_V vector)", () => {
    const decoded = decodeLine(
      "WHEELS_V   100   100   1000   #1",
    ) as DecodedLine;
    expect(decoded.verb).toBe("WHEELS_V");
    expect(decoded.fields).toEqual(["100", "100", "1000"]);
    expect(decoded.id).toBe(1);
  });

  it("leading whitespace on the line is ignored (PING vector)", () => {
    const decoded = decodeLine("   PING") as DecodedLine;
    expect(decoded.verb).toBe("PING");
    expect(decoded.fields).toEqual([]);
    expect(decoded.id).toBeUndefined();
  });
});

describe("golden vectors: HELLO / banner framing", () => {
  it("HELLO decodes with no id (unsequenced)", () => {
    const decoded = decodeLine("HELLO") as DecodedLine;
    expect(decoded).toMatchObject({ verb: "HELLO", fields: [] });
    expect(decoded.id).toBeUndefined();
    expect(classifyLine(decoded.verb)).toBe("command");
  });

  it("the legacy space-form banner reply decodes structurally, and classifies as reply-direction", () => {
    // golden_vectors.txt's own literal HELLO reply.
    const decoded = decodeLine(
      "device NEZHA2 robot testbot SN001",
    ) as DecodedLine;
    expect(decoded).toEqual({
      kind: "line",
      verb: "device",
      fields: ["NEZHA2", "robot", "testbot", "SN001"],
    });
    expect(classifyLine("device")).toBe("reply");
  });
});

describe("golden vectors: id-extraction edge cases", () => {
  it('a trailing token that merely LOOKS id-shaped but lacks "#" is left as an ordinary field, not an id', () => {
    // "IN FROB notanid" -- FROB is not a real verb at all, which is
    // exactly the point: this layer has no verb table, so it decodes
    // structurally regardless, and "notanid" (no leading '#') stays a
    // plain field.
    const decoded = decodeLine("FROB notanid") as DecodedLine;
    expect(decoded.verb).toBe("FROB");
    expect(decoded.fields).toEqual(["notanid"]);
    expect(decoded.id).toBeUndefined();
  });

  it("an id is recoverable even when it leaves no other fields at all (RUN #1)", () => {
    // protocol.md S2.2: the id "is recoverable even from a line that
    // otherwise fails to parse" (RUN needs a function name; codec.ts
    // does not know that, but still extracts the id).
    const decoded = decodeLine("RUN #1") as DecodedLine;
    expect(decoded.verb).toBe("RUN");
    expect(decoded.fields).toEqual([]);
    expect(decoded.id).toBe(1);
  });

  it("a bare verb with nothing after it at all has no id and no fields", () => {
    const decoded = decodeLine("RUN") as DecodedLine;
    expect(decoded.verb).toBe("RUN");
    expect(decoded.fields).toEqual([]);
    expect(decoded.id).toBeUndefined();
  });

  it("an unrecognized verb (PING_TYPO) still decodes structurally with no id", () => {
    const decoded = decodeLine("PING_TYPO") as DecodedLine;
    expect(decoded.verb).toBe("PING_TYPO");
    expect(decoded.fields).toEqual([]);
    expect(decoded.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Hand-written cases: the malformed-id spellings protocol.md S2.2 calls
// out by name are not present in golden_vectors.txt itself, so these are
// authored directly from the spec text rather than sourced from the
// fixture.
// ---------------------------------------------------------------------

describe("malformed id spellings (protocol.md S2.2: bare, unsigned digits only)", () => {
  it("#+5 is not a well-formed id -- stays a literal trailing field", () => {
    const decoded = decodeLine("GET foo #+5") as DecodedLine;
    expect(decoded.fields).toEqual(["foo", "#+5"]);
    expect(decoded.id).toBeUndefined();
  });

  it("#-5 is not a well-formed id -- stays a literal trailing field", () => {
    const decoded = decodeLine("GET foo #-5") as DecodedLine;
    expect(decoded.fields).toEqual(["foo", "#-5"]);
    expect(decoded.id).toBeUndefined();
  });

  it('"# 5" is two tokens (a lone "#" then "5"), neither of which is an id', () => {
    const decoded = decodeLine("GET foo # 5") as DecodedLine;
    expect(decoded.fields).toEqual(["foo", "#", "5"]);
    expect(decoded.id).toBeUndefined();
  });

  it("#0 IS well-formed (ids start at 1, but #0 is still bare unsigned digits)", () => {
    const decoded = decodeLine("GET foo #0") as DecodedLine;
    expect(decoded.fields).toEqual(["foo"]);
    expect(decoded.id).toBe(0);
  });
});

describe("id present vs. absent", () => {
  it("id is undefined, not 0 or '', when no #id suffix is present", () => {
    const decoded = decodeLine("STATUS") as DecodedLine;
    expect("id" in decoded).toBe(false);
    expect(decoded.id).toBeUndefined();
  });

  it("id is a real number when a #id suffix is present", () => {
    const decoded = decodeLine("GET foo #42") as DecodedLine;
    expect(decoded.id).toBe(42);
    expect(typeof decoded.id).toBe("number");
  });
});

// ---------------------------------------------------------------------
// Blank lines
// ---------------------------------------------------------------------

describe("blank lines are ignored silently, not malformed", () => {
  it.each(["", "   ", "\n", "  \n", "\r\n", "   \r\n"])(
    "%j decodes to kind: blank",
    (raw) => {
      expect(decodeLine(raw)).toEqual({ kind: "blank" });
    },
  );
});

// ---------------------------------------------------------------------
// The 240-byte boundary (239 / 240 / 241 bytes, terminator included)
// ---------------------------------------------------------------------

describe("the 240-byte line cap, terminator included", () => {
  // "GET " (4 bytes) + field + "\n" (1 byte) = field.length + 5 bytes.
  function fieldOfTotalLength(totalBytes: number): string {
    return "x".repeat(totalBytes - 5);
  }

  it("encodeLine accepts exactly 240 bytes", () => {
    const field = fieldOfTotalLength(240);
    const line = encodeLine("GET", [field]);
    expect(new TextEncoder().encode(line).length).toBe(240);
  });

  it("encodeLine accepts 239 bytes (under the cap)", () => {
    const field = fieldOfTotalLength(239);
    const line = encodeLine("GET", [field]);
    expect(new TextEncoder().encode(line).length).toBe(239);
  });

  it("encodeLine refuses 241 bytes rather than truncating", () => {
    const field = fieldOfTotalLength(241);
    expect(() => encodeLine("GET", [field])).toThrow(CodecError);
  });

  it("decodeLine accepts a 240-byte line (with its own trailing \\n)", () => {
    const line = "GET " + "x".repeat(235) + "\n"; // 4 + 235 + 1 = 240
    expect(new TextEncoder().encode(line).length).toBe(240);
    const decoded = decodeLine(line);
    expect(decoded.kind).toBe("line");
  });

  it("decodeLine accepts a 239-byte line", () => {
    const line = "GET " + "x".repeat(234) + "\n"; // 239
    const decoded = decodeLine(line);
    expect(decoded.kind).toBe("line");
  });

  it("decodeLine rejects a 241-byte line as tooLong, not a parse error", () => {
    const line = "GET " + "x".repeat(236) + "\n"; // 241
    expect(new TextEncoder().encode(line).length).toBe(241);
    expect(decodeLine(line)).toEqual({ kind: "tooLong", byteLength: 241 });
  });

  it("decodeLine applies the same +1-for-the-terminator accounting when the caller has already stripped '\\n'", () => {
    // Same 236-byte field as the 241-byte case above, but with the
    // trailing '\n' already removed by (a hypothetical) caller -- still
    // 241 wire bytes once the implied terminator is counted.
    const withoutTerminator = "GET " + "x".repeat(236);
    expect(decodeLine(withoutTerminator)).toEqual({
      kind: "tooLong",
      byteLength: 241,
    });
  });

  it(`MAX_LINE_BYTES is 240`, () => {
    expect(MAX_LINE_BYTES).toBe(240);
  });
});

// ---------------------------------------------------------------------
// flags fields: lowercase hex, no 0x prefix
// ---------------------------------------------------------------------

describe("flags-typed fields render as lowercase hex with no 0x prefix", () => {
  it("216 -> 'd8', matching the STATUS golden vector's flags=d8 for the same decimal value", () => {
    // golden_vectors.txt: "SETUP status 1 0 1 1 1 0 216 pose" produces
    // "OUT status ... flags=d8 ..." -- 216 decimal is 0xd8.
    const line = encodeLine("SET", ["some.flags.field", flagsField(216)], 1);
    expect(line).toBe("SET some.flags.field d8 #1\n");
  });

  it("0 -> '0'", () => {
    expect(encodeLine("SET", ["f", flagsField(0)])).toBe("SET f 0\n");
  });

  it("rejects a negative flags value", () => {
    expect(() => flagsField(-1)).toThrow(CodecError);
  });

  it("rejects a non-integer flags value", () => {
    expect(() => flagsField(1.5)).toThrow(CodecError);
  });
});

// ---------------------------------------------------------------------
// encodeLine: refusal cases beyond the byte cap
// ---------------------------------------------------------------------

describe("encodeLine refuses rather than emitting a non-conformant line", () => {
  it("rejects a verb that doesn't match [A-Za-z][A-Za-z0-9_]*", () => {
    expect(() => encodeLine("1BAD", [])).toThrow(CodecError);
    expect(() => encodeLine("has space", [])).toThrow(CodecError);
    expect(() => encodeLine("", [])).toThrow(CodecError);
  });

  it("rejects a string field containing whitespace", () => {
    expect(() => encodeLine("SET", ["has space"])).toThrow(CodecError);
  });

  it("rejects an empty string field", () => {
    expect(() => encodeLine("SET", [""])).toThrow(CodecError);
  });

  it("rejects a non-finite number field", () => {
    expect(() => encodeLine("SET", [NaN])).toThrow(CodecError);
    expect(() => encodeLine("SET", [Infinity])).toThrow(CodecError);
  });

  it("rejects a negative id", () => {
    expect(() => encodeLine("GET", ["foo"], -1)).toThrow(CodecError);
  });

  it("rejects a non-integer id", () => {
    expect(() => encodeLine("GET", ["foo"], 1.5)).toThrow(CodecError);
  });

  it("renders a decimal field without exponential notation (config values, S7.2)", () => {
    // golden_vectors.txt's own worked example.
    expect(encodeLine("SET", ["wheel_control.pid_kp", 0.03], 1)).toBe(
      "SET wheel_control.pid_kp 0.03 #1\n",
    );
  });

  it("renders a very small decimal without exponential notation (codec.py's own documented 1e-08 trap)", () => {
    expect(encodeLine("SET", ["f", 1e-8])).toBe("SET f 0.00000001\n");
  });
});

// ---------------------------------------------------------------------
// encodeLine: no id given -> no '#' section at all
// ---------------------------------------------------------------------

describe("encodeLine with no id omits the '#' section entirely", () => {
  it("PING with no id", () => {
    expect(encodeLine("PING", [])).toBe("PING\n");
  });

  it("a sequenced-shaped verb with an id appends exactly one #id token, always last", () => {
    expect(encodeLine("GET", ["wheel_control.pid_kp"], 7)).toBe(
      "GET wheel_control.pid_kp #7\n",
    );
  });
});

// ---------------------------------------------------------------------
// classifyLine / isReplyVerb -- case is direction
// ---------------------------------------------------------------------

describe("classifyLine: case is direction (protocol.md S2.1)", () => {
  it("an uppercase verb classifies as command-direction", () => {
    expect(classifyLine("HELLO")).toBe("command");
    expect(classifyLine("GET")).toBe("command");
  });

  it("a lowercase, known reply verb classifies as reply-direction", () => {
    for (const verb of REPLY_VERBS) {
      expect(classifyLine(verb)).toBe("reply");
      expect(isReplyVerb(verb)).toBe(true);
    }
  });

  it("a lowercase verb that is NOT a known reply is foreign traffic to drop silently, not an error", () => {
    expect(classifyLine("banana")).toBe("foreign");
    expect(classifyLine("somethingelse")).toBe("foreign");
    expect(isReplyVerb("banana")).toBe(false);
  });

  it("verb lookup is case-sensitive: 'ACK' is not 'ack'", () => {
    expect(isReplyVerb("ACK")).toBe(false);
    expect(classifyLine("ACK")).toBe("command");
  });

  it("the CURRENT colon-form HELLO banner sentinel classifies as command-direction (protocol.md S2.4's own flagged note)", () => {
    // decodeLine has no ':' delimiter knowledge, so this single colon-
    // joined token decodes as one verb with no fields at all -- exactly
    // the behavior S2.4 itself describes ("tokenises it as one unknown
    // token with no trailing #id").
    const decoded = decodeLine(
      "DEVICE:NEZHA2:robot:vevov:1198504156",
    ) as DecodedLine;
    expect(decoded.verb).toBe("DEVICE:NEZHA2:robot:vevov:1198504156");
    expect(decoded.fields).toEqual([]);
    expect(decoded.id).toBeUndefined();
    expect(classifyLine(decoded.verb)).toBe("command");
  });
});
