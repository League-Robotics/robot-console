import { describe, expect, it } from "vitest";
import { parseBanner } from "./banner.js";

describe("parseBanner", () => {
  it("parses the colon-form RADIOBRIDGE example with a decimal serial", () => {
    const result = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    expect(result).toEqual({
      role: "RADIOBRIDGE",
      commonName: "relay",
      name: "getez",
      serial: 1779042496,
      dialect: "colon",
      raw: "DEVICE:RADIOBRIDGE:relay:getez:1779042496",
    });
  });

  it("parses a legacy colon-form RADIORELAY example with a hexadecimal serial", () => {
    // Same physical FICR.DEVICEID[1] value as the RADIOBRIDGE example
    // above (1779042496 decimal), but legacy MakeCode relay firmware
    // prints it in hex instead.
    const result = parseBanner("DEVICE:RADIORELAY:relay:getez:6a0a08c0");
    expect(result).toEqual({
      role: "RADIORELAY",
      commonName: "relay",
      name: "getez",
      serial: 0x6a0a08c0,
      dialect: "colon",
      raw: "DEVICE:RADIORELAY:relay:getez:6a0a08c0",
    });
    expect(result?.serial).toBe(1779042496);
  });

  it("parses the space-form NEZHA2 example with a decimal serial", () => {
    const result = parseBanner("device NEZHA2 robot vevov 1198504156");
    expect(result).toEqual({
      role: "NEZHA2",
      commonName: "robot",
      name: "vevov",
      serial: 1198504156,
      dialect: "space",
      raw: "device NEZHA2 robot vevov 1198504156",
    });
  });

  it("produces the same shaped output for both dialects", () => {
    const colon = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    const space = parseBanner("device NEZHA2 robot vevov 1198504156");
    expect(colon && Object.keys(colon).sort()).toEqual(
      space && Object.keys(space).sort(),
    );
  });

  it("parses an unrecognized role rather than rejecting it, defaulting to decimal", () => {
    const result = parseBanner("DEVICE:RADIOTHING2:relay:qzxty:42");
    expect(result).toEqual({
      role: "RADIOTHING2",
      commonName: "relay",
      name: "qzxty",
      serial: 42,
      dialect: "colon",
      raw: "DEVICE:RADIOTHING2:relay:qzxty:42",
    });
  });

  it("returns null for a line matching neither grammar", () => {
    expect(parseBanner("not a banner at all")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseBanner("")).toBeNull();
  });

  it("returns null for a colon-form line missing fields", () => {
    expect(parseBanner("DEVICE:RADIOBRIDGE:relay:getez")).toBeNull();
  });

  it("returns null for a colon-form line with a non-hex serial token", () => {
    expect(parseBanner("DEVICE:RADIOBRIDGE:relay:getez:not-a-number")).toBeNull();
  });

  it("returns null for an uppercase space-form sentinel (DEVICE is the colon sentinel only)", () => {
    expect(parseBanner("DEVICE NEZHA2 robot vevov 1198504156")).toBeNull();
  });

  it("returns null for a space-form line missing fields", () => {
    expect(parseBanner("device NEZHA2 robot vevov")).toBeNull();
  });
});
