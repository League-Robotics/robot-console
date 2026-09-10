import { describe, expect, it } from "vitest";
import {
  parseTelemetryHeader,
  zipTelemetryFrame,
  TelemetryDecoder,
  type TelemetryDecodeResult,
} from "./telemetry.js";

// ---------------------------------------------------------------------
// Real column-set fixtures, so the "identical decode path across every
// header shape" claim is tested against actual wire shapes, not
// invented ones.
//
//   - radio-robot-lib's DiffDriveAdapter POSE (7 cols) / FULL (11 cols):
//     protocol.md S10.2's own worked example, and S10.3's column table.
//   - This repo's robot firmware (wire_adapter.cpp, WireAdapter::
//     buildSnapshot()) POSE (12 cols) / FULL (20 cols).
// ---------------------------------------------------------------------

const RADIO_LIB_POSE_HEADER = ["seq", "now", "flags", "posl", "posr", "vell", "velr"];
const RADIO_LIB_POSE_FIELDS = ["5", "1080", "3", "120", "118", "250", "248"];

const RADIO_LIB_FULL_HEADER = [
  ...RADIO_LIB_POSE_HEADER,
  "lambda",
  "biasl",
  "biasr",
  "cyc",
];
const RADIO_LIB_FULL_FIELDS = [...RADIO_LIB_POSE_FIELDS, "500", "2", "-3", "1000"];

const FIRMWARE_POSE_HEADER = [
  "seq",
  "now",
  "flags",
  "x",
  "y",
  "h",
  "ox",
  "oy",
  "oh",
  "vl",
  "vr",
  "i2cf",
];
const FIRMWARE_POSE_FIELDS = [
  "12",
  "20480",
  "d8",
  "1000",
  "2000",
  "9000",
  "-567",
  "123",
  "18000",
  "250",
  "-248",
  "0",
];

const FIRMWARE_FULL_HEADER = [
  ...FIRMWARE_POSE_HEADER,
  "cyc",
  "posl",
  "posr",
  "dutl",
  "dutr",
  "lexc",
  "wrng",
  "cycovr",
];
const FIRMWARE_FULL_FIELDS = [
  ...FIRMWARE_POSE_FIELDS,
  "40000",
  "5000",
  "4980",
  "512",
  "-512",
  "0",
  "0",
  "1",
];

const FIXTURES: Array<{
  name: string;
  header: readonly string[];
  fields: readonly string[];
}> = [
  { name: "radio-robot-lib POSE (7 cols)", header: RADIO_LIB_POSE_HEADER, fields: RADIO_LIB_POSE_FIELDS },
  { name: "radio-robot-lib FULL (11 cols)", header: RADIO_LIB_FULL_HEADER, fields: RADIO_LIB_FULL_FIELDS },
  { name: "firmware POSE (12 cols)", header: FIRMWARE_POSE_HEADER, fields: FIRMWARE_POSE_FIELDS },
  { name: "firmware FULL (20 cols)", header: FIRMWARE_FULL_HEADER, fields: FIRMWARE_FULL_FIELDS },
];

describe("zipTelemetryFrame -- schemaless positional zip", () => {
  it.each(FIXTURES)(
    "zips $name through the identical code path with no column-count branch",
    ({ header, fields }) => {
      const result = zipTelemetryFrame(header, fields);
      expect(result.kind).toBe("frame");
      const frame = result as Extract<typeof result, { kind: "frame" }>;
      expect(Object.keys(frame.fields)).toHaveLength(header.length);
      header.forEach((columnName, i) => {
        expect(frame.fields[columnName]).toBe(fields[i]);
      });
    },
  );

  it("via TelemetryDecoder, decodes the same fixtures identically after handleHeader", () => {
    for (const { header, fields } of FIXTURES) {
      const decoder = new TelemetryDecoder();
      decoder.handleHeader(header);
      expect(decoder.currentHeader).toEqual(header);
      const result = decoder.decodeFrame(fields);
      expect(result.kind).toBe("frame");
      const frame = result as Extract<TelemetryDecodeResult, { kind: "frame" }>;
      header.forEach((columnName, i) => {
        expect(frame.fields[columnName]).toBe(fields[i]);
      });
    }
  });
});

describe("parseTelemetryHeader", () => {
  it("is an identity pass-through of a thdr line's fields", () => {
    expect(parseTelemetryHeader(RADIO_LIB_POSE_HEADER)).toEqual(RADIO_LIB_POSE_HEADER);
  });
});

// ---------------------------------------------------------------------
// The three unit traps this ticket exists to pin. Each of these would
// have failed under a previous, non-schemaless decoder that special-
// cased these column names to apply a scale factor -- the whole point
// of this module is that it never does.
// ---------------------------------------------------------------------

describe("unit traps -- no conversion is ever applied, regardless of column name", () => {
  it("ox/oy pass through completely unscaled (already-mm wire values, not divided or multiplied)", () => {
    const header = ["seq", "ox", "oy"];
    // -567 mm and 123 mm are the ALREADY-CONVERTED wire values
    // (wire_adapter.cpp divides the raw 0.1mm OTOS reading by 10 before
    // ever putting it on the wire) -- the decoder must hand these back
    // completely as-is.
    const fields = ["12", "-567", "123"];
    const result = zipTelemetryFrame(header, fields);
    expect(result.kind).toBe("frame");
    const frame = result as Extract<typeof result, { kind: "frame" }>;
    expect(frame.fields["ox"]).toBe("-567");
    expect(frame.fields["oy"]).toBe("123");
  });

  it("oh passes through completely undivided (already centidegrees on the wire, not divided by 100)", () => {
    const header = ["seq", "oh"];
    const fields = ["12", "18000"];
    const result = zipTelemetryFrame(header, fields);
    expect(result.kind).toBe("frame");
    const frame = result as Extract<typeof result, { kind: "frame" }>;
    // Pin the trap explicitly: the decoded value is the raw wire text,
    // NOT that value divided by 100 (which a "helpfully" unit-aware
    // decoder might apply, mistaking centidegrees for something needing
    // reduction the way ox/oy's own 0.1mm reading does).
    expect(frame.fields["oh"]).toBe("18000");
    expect(frame.fields["oh"]).not.toBe(String(18000 / 100));
  });

  it("rotation/omega pass through as raw milliradians, with no scaling applied", () => {
    const header = ["seq", "rotation", "omega"];
    const fields = ["12", "1571", "-500"];
    const result = zipTelemetryFrame(header, fields);
    expect(result.kind).toBe("frame");
    const frame = result as Extract<typeof result, { kind: "frame" }>;
    expect(frame.fields["rotation"]).toBe("1571");
    expect(frame.fields["omega"]).toBe("-500");
  });
});

describe("field-count mismatch", () => {
  it("is reported explicitly, not zipped short, when a t line has fewer fields than the header", () => {
    const header = RADIO_LIB_POSE_HEADER; // 7 columns
    const shortFields = RADIO_LIB_POSE_FIELDS.slice(0, 5); // 5 fields
    const result = zipTelemetryFrame(header, shortFields);
    expect(result).toEqual({
      kind: "fieldCountMismatch",
      expectedFieldCount: 7,
      actualFieldCount: 5,
    });
  });

  it("is reported explicitly when a t line has MORE fields than the header", () => {
    const header = RADIO_LIB_POSE_HEADER; // 7 columns
    const longFields = [...RADIO_LIB_POSE_FIELDS, "999"]; // 8 fields
    const result = zipTelemetryFrame(header, longFields);
    expect(result).toEqual({
      kind: "fieldCountMismatch",
      expectedFieldCount: 7,
      actualFieldCount: 8,
    });
  });

  it("surfaces the same mismatch through TelemetryDecoder once a header is held", () => {
    const decoder = new TelemetryDecoder();
    decoder.handleHeader(FIRMWARE_POSE_HEADER); // 12 columns
    const result = decoder.decodeFrame(FIRMWARE_POSE_FIELDS.slice(0, 3));
    expect(result).toEqual({
      kind: "fieldCountMismatch",
      expectedFieldCount: 12,
      actualFieldCount: 3,
    });
  });
});

describe("no header held", () => {
  it("is surfaced explicitly, not thrown or guessed, when a t line arrives before any thdr", () => {
    const decoder = new TelemetryDecoder();
    expect(decoder.currentHeader).toBeUndefined();
    const result = decoder.decodeFrame(RADIO_LIB_POSE_FIELDS);
    expect(result).toEqual({ kind: "noHeaderHeld" });
  });

  it("resolves once a header is later provided via handleHeader", () => {
    const decoder = new TelemetryDecoder();
    expect(decoder.decodeFrame(RADIO_LIB_POSE_FIELDS)).toEqual({ kind: "noHeaderHeld" });
    decoder.handleHeader(RADIO_LIB_POSE_HEADER);
    const result = decoder.decodeFrame(RADIO_LIB_POSE_FIELDS);
    expect(result.kind).toBe("frame");
  });
});
